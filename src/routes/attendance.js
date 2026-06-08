const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

function getDefaultSchedule(timeSlot) {
  if (timeSlot === "上午") {
    return { start_time: "09:00:00", end_time: "11:30:00" };
  } else if (timeSlot === "下午") {
    return { start_time: "14:00:00", end_time: "17:00:00" };
  }
  return { start_time: "09:00:00", end_time: "17:00:00" };
}

function getTimeSlotByTime(timeStr) {
  const hour = parseInt(timeStr.split(":")[0]);
  if (hour < 12) return "上午";
  return "下午";
}

async function getScheduleForDate(lawyerId, dateStr) {
  const [schedules] = await pool.execute(
    "SELECT * FROM schedules WHERE lawyer_id = ? AND schedule_date = ? AND status = '正常'",
    [lawyerId, dateStr]
  );
  if (schedules.length > 0) {
    return schedules;
  }
  const defaultSchedule = {
    id: null,
    lawyer_id: lawyerId,
    schedule_date: dateStr,
    time_slot: "全天",
    start_time: "09:00:00",
    end_time: "17:00:00",
    status: "正常"
  };
  return [defaultSchedule];
}

function calculateMinutesDiff(time1, time2) {
  const [h1, m1] = time1.split(":").map(Number);
  const [h2, m2] = time2.split(":").map(Number);
  return (h1 * 60 + m1) - (h2 * 60 + m2);
}

router.post("/check-in", async (req, res) => {
  const { lawyer_id, check_in_time } = req.body;
  if (!lawyer_id) {
    return res.status(400).json({ error: "律师ID为必填" });
  }
  const checkInTime = check_in_time ? new Date(check_in_time) : new Date();
  if (isNaN(checkInTime.getTime())) {
    return res.status(400).json({ error: "签到时间格式无效" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const dateStr = checkInTime.toISOString().split("T")[0];
    const timeStr = checkInTime.toTimeString().split(" ")[0];
    const timeSlot = getTimeSlotByTime(timeStr);

    const schedules = await getScheduleForDate(lawyer_id, dateStr);
    let matchedSchedule = schedules.find(s => 
      s.time_slot === "全天" || s.time_slot === timeSlot
    );
    if (!matchedSchedule) {
      matchedSchedule = schedules[0];
    }

    const startTime = matchedSchedule.start_time;
    const lateMinutes = calculateMinutesDiff(timeStr, startTime);
    const isLate = lateMinutes > 15 ? 1 : 0;

    const [existing] = await conn.execute(
      "SELECT id FROM attendance_records WHERE lawyer_id = ? AND DATE(check_in) = ? AND check_out IS NULL",
      [lawyer_id, dateStr]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: "今日已有未签退的签到记录" });
    }

    const [result] = await conn.execute(
      `INSERT INTO attendance_records 
       (lawyer_id, schedule_id, check_in, is_late, status) 
       VALUES (?, ?, ?, ?, '正常')`,
      [lawyer_id, matchedSchedule.id, checkInTime, isLate]
    );

    await conn.commit();
    res.status(201).json({
      id: result.insertId,
      message: "签到成功",
      check_in: checkInTime,
      is_late: !!isLate,
      late_minutes: lateMinutes > 0 ? lateMinutes : 0
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.post("/check-out", async (req, res) => {
  const { lawyer_id, check_out_time } = req.body;
  if (!lawyer_id) {
    return res.status(400).json({ error: "律师ID为必填" });
  }
  const checkOutTime = check_out_time ? new Date(check_out_time) : new Date();
  if (isNaN(checkOutTime.getTime())) {
    return res.status(400).json({ error: "签退时间格式无效" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const dateStr = checkOutTime.toISOString().split("T")[0];

    const [records] = await conn.execute(
      "SELECT * FROM attendance_records WHERE lawyer_id = ? AND DATE(check_in) = ? AND check_out IS NULL ORDER BY check_in ASC LIMIT 1",
      [lawyer_id, dateStr]
    );
    if (records.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "未找到今日签到记录" });
    }

    const record = records[0];
    const checkInTime = new Date(record.check_in);
    const workMs = checkOutTime.getTime() - checkInTime.getTime();
    const workHours = Math.round((workMs / (1000 * 60 * 60)) * 10) / 10;

    const timeStr = checkOutTime.toTimeString().split(" ")[0];
    const timeSlot = getTimeSlotByTime(timeStr);

    let scheduleEndTime = "17:00:00";
    if (record.schedule_id) {
      const [schedules] = await conn.execute(
        "SELECT end_time, time_slot FROM schedules WHERE id = ?",
        [record.schedule_id]
      );
      if (schedules.length > 0) {
        scheduleEndTime = schedules[0].end_time;
      }
    }

    const earlyMinutes = calculateMinutesDiff(scheduleEndTime, timeStr);
    const isEarlyLeave = earlyMinutes > 15 ? 1 : 0;

    await conn.execute(
      `UPDATE attendance_records 
       SET check_out = ?, work_hours = ?, is_early_leave = ?
       WHERE id = ?`,
      [checkOutTime, workHours, isEarlyLeave, record.id]
    );

    const [wlr] = await conn.execute(
      "SELECT id FROM workload_records WHERE lawyer_id = ? AND record_month = ?",
      [lawyer_id, dateStr.substring(0, 7)]
    );
    if (wlr.length > 0) {
      await conn.execute(
        `UPDATE workload_records SET work_hours = work_hours + ? WHERE id = ?`,
        [workHours, wlr[0].id]
      );
    } else {
      await conn.execute(
        `INSERT INTO workload_records (lawyer_id, record_month, work_hours) VALUES (?, ?, ?)`,
        [lawyer_id, dateStr.substring(0, 7), workHours]
      );
    }

    await conn.commit();
    res.json({
      id: record.id,
      message: "签退成功",
      check_out: checkOutTime,
      work_hours: workHours,
      is_early_leave: !!isEarlyLeave,
      early_minutes: earlyMinutes > 0 ? earlyMinutes : 0
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/records", async (req, res) => {
  const { lawyer_id, start_date, end_date, status, page = 1, size = 20 } = req.query;
  let where = [];
  let params = [];

  if (lawyer_id) {
    where.push("ar.lawyer_id = ?");
    params.push(lawyer_id);
  }
  if (start_date) {
    where.push("DATE(ar.check_in) >= ?");
    params.push(start_date);
  }
  if (end_date) {
    where.push("DATE(ar.check_in) <= ?");
    params.push(end_date);
  }
  if (status) {
    where.push("ar.status = ?");
    params.push(status);
  }

  const whereStr = where.length > 0 ? " WHERE " + where.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM attendance_records ar${whereStr}`,
    params
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.query(
    `SELECT ar.*, l.name as lawyer_name, l.license_no 
     FROM attendance_records ar 
     LEFT JOIN lawyers l ON ar.lawyer_id = l.id
     ${whereStr} 
     ORDER BY ar.check_in DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/records/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    `SELECT ar.*, l.name as lawyer_name 
     FROM attendance_records ar 
     LEFT JOIN lawyers l ON ar.lawyer_id = l.id 
     WHERE ar.id = ?`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: "考勤记录不存在" });
  res.json(row);
});

router.put("/records/:id", async (req, res) => {
  const { check_in, check_out, status, remarks } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[record]] = await conn.execute(
      "SELECT * FROM attendance_records WHERE id = ?",
      [req.params.id]
    );
    if (!record) {
      await conn.rollback();
      return res.status(404).json({ error: "考勤记录不存在" });
    }

    let workHours = record.work_hours;
    const newCheckIn = check_in || record.check_in;
    const newCheckOut = check_out || record.check_out;
    if (newCheckIn && newCheckOut) {
      const workMs = new Date(newCheckOut).getTime() - new Date(newCheckIn).getTime();
      workHours = Math.round((workMs / (1000 * 60 * 60)) * 10) / 10;
    }

    const [result] = await conn.execute(
      `UPDATE attendance_records 
       SET check_in = COALESCE(?, check_in), 
           check_out = COALESCE(?, check_out),
           work_hours = ?,
           status = COALESCE(?, status),
           remarks = COALESCE(?, remarks)
       WHERE id = ?`,
      [check_in || null, check_out || null, workHours, status || null, remarks || null, req.params.id]
    );

    await conn.commit();
    res.json({ message: "考勤记录更新成功" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
