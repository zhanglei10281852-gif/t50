const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.get("/monthly-summary", async (req, res) => {
  const { month, lawyer_id } = req.query;
  if (!month) {
    return res.status(400).json({ error: "月份为必填，格式: YYYY-MM" });
  }

  const conn = await pool.getConnection();
  try {
    const [lawyers] = lawyer_id
      ? await conn.execute(
          "SELECT id, name, license_no FROM lawyers WHERE id = ?",
          [lawyer_id],
        )
      : await conn.execute("SELECT id, name, license_no FROM lawyers");

    const results = [];

    for (const lawyer of lawyers) {
      const summary = await calculateMonthlySummary(conn, lawyer.id, month);
      results.push({
        lawyer_id: lawyer.id,
        lawyer_name: lawyer.name,
        license_no: lawyer.license_no,
        month,
        ...summary,
      });
    }

    res.json({ data: results, total: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

async function calculateMonthlySummary(conn, lawyerId, month) {
  const [year, monthNum] = month.split("-").map(Number);
  const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01`;
  const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

  const [[{ schedule_count }]] = await conn.execute(
    `SELECT COUNT(*) as schedule_count FROM schedules 
     WHERE lawyer_id = ? AND schedule_date BETWEEN ? AND ? AND status != '请假'`,
    [lawyerId, startDate, endDate],
  );

  let expectedDutyCount = schedule_count;
  if (schedule_count === 0) {
    const weekdayCount = await countWeekdays(year, monthNum);
    expectedDutyCount = weekdayCount;
  }

  const [attendanceRecords] = await conn.execute(
    `SELECT * FROM attendance_records 
     WHERE lawyer_id = ? AND DATE(check_in) BETWEEN ? AND ?`,
    [lawyerId, startDate, endDate],
  );

  const actualCheckInCount = attendanceRecords.filter((r) => r.check_in).length;
  const lateCount = attendanceRecords.filter((r) => r.is_late).length;
  const earlyLeaveCount = attendanceRecords.filter(
    (r) => r.is_early_leave,
  ).length;
  const totalWorkHours = attendanceRecords.reduce(
    (sum, r) => sum + (parseFloat(r.work_hours) || 0),
    0,
  );

  const [[{ leave_count }]] = await conn.execute(
    `SELECT COUNT(*) as leave_count FROM leaves 
     WHERE lawyer_id = ? AND leave_date BETWEEN ? AND ? AND status = '已通过'`,
    [lawyerId, startDate, endDate],
  );

  const absentCount = Math.max(
    0,
    expectedDutyCount - actualCheckInCount - leave_count,
  );

  const attendanceRate =
    expectedDutyCount > 0
      ? Math.round(
          ((actualCheckInCount - lateCount - earlyLeaveCount) /
            expectedDutyCount) *
            1000,
        ) / 10
      : 0;

  return {
    expected_duty_count: expectedDutyCount,
    actual_checkin_count: actualCheckInCount,
    late_count: lateCount,
    early_leave_count: earlyLeaveCount,
    leave_count: leave_count,
    absent_count: absentCount,
    total_work_hours: Math.round(totalWorkHours * 10) / 10,
    attendance_rate: attendanceRate,
  };
}

function countWeekdays(year, month) {
  let count = 0;
  const date = new Date(year, month - 1, 1);
  while (date.getMonth() === month - 1) {
    const day = date.getDay();
    if (day >= 1 && day <= 5) {
      count++;
    }
    date.setDate(date.getDate() + 1);
  }
  return count;
}

router.get("/workload", async (req, res) => {
  const { month, lawyer_id } = req.query;
  if (!month) {
    return res.status(400).json({ error: "月份为必填，格式: YYYY-MM" });
  }

  const conn = await pool.getConnection();
  try {
    const [lawyers] = lawyer_id
      ? await conn.execute(
          "SELECT id, name, license_no FROM lawyers WHERE id = ?",
          [lawyer_id],
        )
      : await conn.execute("SELECT id, name, license_no FROM lawyers");

    const results = [];

    for (const lawyer of lawyers) {
      const workload = await calculateWorkload(conn, lawyer.id, month);
      results.push({
        lawyer_id: lawyer.id,
        lawyer_name: lawyer.name,
        license_no: lawyer.license_no,
        month,
        ...workload,
      });
    }

    results.sort((a, b) => b.comprehensive_score - a.comprehensive_score);
    res.json({ data: results, total: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

async function calculateWorkload(conn, lawyerId, month) {
  const [year, monthNum] = month.split("-").map(Number);
  const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01`;
  const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

  const [[record]] = await conn.execute(
    "SELECT * FROM workload_records WHERE lawyer_id = ? AND record_month = ?",
    [lawyerId, month],
  );

  const [[{ case_count }]] = await conn.execute(
    `SELECT COUNT(*) as case_count FROM cases 
     WHERE lawyer_id = ? AND DATE(created_at) BETWEEN ? AND ? AND status != '已驳回'`,
    [lawyerId, startDate, endDate],
  );

  const workHours = record ? parseFloat(record.work_hours) : 0;
  const consultationCount = record ? record.consultation_count : 0;
  const totalCaseCount = (record ? record.case_count : 0) + case_count;

  const comprehensiveScore = Math.round(
    workHours * 1 + consultationCount * 2 + totalCaseCount * 5,
  );

  return {
    work_hours: Math.round(workHours * 10) / 10,
    consultation_count: consultationCount,
    case_count: totalCaseCount,
    comprehensive_score: comprehensiveScore,
  };
}

router.put("/workload/:lawyer_id", async (req, res) => {
  const { month, consultation_count, case_count } = req.body;
  if (!month) {
    return res.status(400).json({ error: "月份为必填" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[record]] = await conn.execute(
      "SELECT id FROM workload_records WHERE lawyer_id = ? AND record_month = ?",
      [req.params.lawyer_id, month],
    );

    if (record) {
      const updates = [];
      const params = [];
      if (consultation_count !== undefined) {
        updates.push("consultation_count = ?");
        params.push(consultation_count);
      }
      if (case_count !== undefined) {
        updates.push("case_count = ?");
        params.push(case_count);
      }
      if (updates.length > 0) {
        params.push(req.params.lawyer_id, month);
        await conn.execute(
          `UPDATE workload_records SET ${updates.join(", ")} WHERE lawyer_id = ? AND record_month = ?`,
          params,
        );
      }
    } else {
      await conn.execute(
        `INSERT INTO workload_records 
         (lawyer_id, record_month, consultation_count, case_count)
         VALUES (?, ?, ?, ?)`,
        [req.params.lawyer_id, month, consultation_count || 0, case_count || 0],
      );
    }

    await conn.commit();
    res.json({ message: "工作量数据更新成功" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/attendance-ranking", async (req, res) => {
  const { month } = req.query;
  if (!month) {
    return res.status(400).json({ error: "月份为必填，格式: YYYY-MM" });
  }

  const conn = await pool.getConnection();
  try {
    const [lawyers] = await conn.execute(
      "SELECT id, name, license_no FROM lawyers",
    );
    const rankings = [];

    for (const lawyer of lawyers) {
      const summary = await calculateMonthlySummary(conn, lawyer.id, month);
      rankings.push({
        lawyer_id: lawyer.id,
        lawyer_name: lawyer.name,
        license_no: lawyer.license_no,
        attendance_rate: summary.attendance_rate,
        total_work_hours: summary.total_work_hours,
      });
    }

    rankings.sort((a, b) => b.attendance_rate - a.attendance_rate);

    const avgWorkHours =
      rankings.length > 0
        ? Math.round(
            (rankings.reduce((sum, r) => sum + r.total_work_hours, 0) /
              rankings.length) *
              10,
          ) / 10
        : 0;

    res.json({
      month,
      average_work_hours: avgWorkHours,
      rankings: rankings.map((r, i) => ({ ...r, rank: i + 1 })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/late-trend", async (req, res) => {
  const { start_month, end_month } = req.query;
  if (!start_month || !end_month) {
    return res.status(400).json({ error: "开始月份和结束月份为必填" });
  }

  const conn = await pool.getConnection();
  try {
    const months = generateMonthRange(start_month, end_month);
    const trends = [];

    for (const month of months) {
      const [year, monthNum] = month.split("-").map(Number);
      const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01`;
      const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

      const [[{ total_late }]] = await conn.execute(
        `SELECT COUNT(*) as total_late FROM attendance_records 
         WHERE DATE(check_in) BETWEEN ? AND ? AND is_late = 1`,
        [startDate, endDate],
      );

      const [[{ total_attendance }]] = await conn.execute(
        `SELECT COUNT(*) as total_attendance FROM attendance_records 
         WHERE DATE(check_in) BETWEEN ? AND ?`,
        [startDate, endDate],
      );

      const lateRate =
        total_attendance > 0
          ? Math.round((total_late / total_attendance) * 1000) / 10
          : 0;

      trends.push({
        month,
        total_late,
        total_attendance,
        late_rate: lateRate,
      });
    }

    res.json({ data: trends });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

function generateMonthRange(start, end) {
  const months = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);

  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${m.toString().padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

router.get("/leave-distribution", async (req, res) => {
  const { month } = req.query;
  if (!month) {
    return res.status(400).json({ error: "月份为必填，格式: YYYY-MM" });
  }

  const conn = await pool.getConnection();
  try {
    const [year, monthNum] = month.split("-").map(Number);
    const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01`;
    const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

    const [[{ total_leaves }]] = await conn.execute(
      `SELECT COUNT(*) as total_leaves FROM leaves 
       WHERE leave_date BETWEEN ? AND ? AND status = '已通过'`,
      [startDate, endDate],
    );

    const [timeSlotData] = await conn.execute(
      `SELECT time_slot, COUNT(*) as count FROM leaves 
       WHERE leave_date BETWEEN ? AND ? AND status = '已通过'
       GROUP BY time_slot`,
      [startDate, endDate],
    );

    const [lawyerRanking] = await conn.execute(
      `SELECT l.lawyer_id, lw.name as lawyer_name, COUNT(*) as leave_count 
       FROM leaves l
       LEFT JOIN lawyers lw ON l.lawyer_id = lw.id
       WHERE l.leave_date BETWEEN ? AND ? AND l.status = '已通过'
       GROUP BY l.lawyer_id
       ORDER BY leave_count DESC
       LIMIT 10`,
      [startDate, endDate],
    );

    const distribution = {};
    timeSlotData.forEach((item) => {
      distribution[item.time_slot] = {
        count: item.count,
        percentage:
          total_leaves > 0
            ? Math.round((item.count / total_leaves) * 1000) / 10
            : 0,
      };
    });

    res.json({
      month,
      total_leaves,
      time_slot_distribution: distribution,
      lawyer_ranking: lawyerRanking,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/workload-comparison", async (req, res) => {
  const { month } = req.query;
  if (!month) {
    return res.status(400).json({ error: "月份为必填，格式: YYYY-MM" });
  }

  const conn = await pool.getConnection();
  try {
    const [lawyers] = await conn.execute(
      "SELECT id, name, license_no FROM lawyers",
    );
    const comparisons = [];

    for (const lawyer of lawyers) {
      const workload = await calculateWorkload(conn, lawyer.id, month);
      comparisons.push({
        lawyer_id: lawyer.id,
        lawyer_name: lawyer.name,
        license_no: lawyer.license_no,
        work_hours: workload.work_hours,
        consultation_count: workload.consultation_count,
        case_count: workload.case_count,
        comprehensive_score: workload.comprehensive_score,
      });
    }

    comparisons.sort((a, b) => b.comprehensive_score - a.comprehensive_score);

    res.json({
      month,
      data: comparisons.map((item, index) => ({ ...item, rank: index + 1 })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
