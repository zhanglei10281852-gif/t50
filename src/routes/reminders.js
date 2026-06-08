const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.get("/", async (req, res) => {
  const { type, lawyer_id, is_read, page = 1, size = 20 } = req.query;
  let where = [];
  let params = [];

  if (type) {
    where.push("r.type = ?");
    params.push(type);
  }
  if (lawyer_id) {
    where.push("r.lawyer_id = ?");
    params.push(lawyer_id);
  }
  if (is_read !== undefined) {
    where.push("r.is_read = ?");
    params.push(is_read === "true" || is_read === "1" ? 1 : 0);
  }

  const whereStr = where.length > 0 ? " WHERE " + where.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM reminders r${whereStr}`,
    params,
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.query(
    `SELECT r.*, l.name as lawyer_name 
     FROM reminders r 
     LEFT JOIN lawyers l ON r.lawyer_id = l.id
     ${whereStr} 
     ORDER BY r.created_at DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.put("/:id/read", async (req, res) => {
  const [result] = await pool.execute(
    "UPDATE reminders SET is_read = 1 WHERE id = ?",
    [req.params.id],
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "提醒不存在" });
  }
  res.json({ message: "标记已读成功" });
});

router.put("/read-all", async (req, res) => {
  const { lawyer_id } = req.body;
  let where = "";
  let params = [];
  if (lawyer_id) {
    where = " WHERE lawyer_id = ? AND is_read = 0";
    params.push(lawyer_id);
  } else {
    where = " WHERE is_read = 0";
  }

  const [result] = await pool.execute(
    `UPDATE reminders SET is_read = 1${where}`,
    params,
  );
  res.json({ message: "全部标记已读", count: result.affectedRows });
});

router.get("/unread-count", async (req, res) => {
  const { lawyer_id } = req.query;
  let where = " WHERE is_read = 0";
  let params = [];
  if (lawyer_id) {
    where += " AND lawyer_id = ?";
    params.push(lawyer_id);
  }

  const [[{ count }]] = await pool.execute(
    `SELECT COUNT(*) as count FROM reminders${where}`,
    params,
  );
  res.json({ unread_count: count });
});

router.post("/check-absent", async (req, res) => {
  try {
    const result = await checkContinuousAbsent();
    res.json({ message: "疑似脱岗检查完成", ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/check-late", async (req, res) => {
  const { month } = req.body;
  const targetMonth = month || new Date().toISOString().substring(0, 7);
  try {
    const result = await checkMonthlyLate(targetMonth);
    res.json({ message: "考勤异常检查完成", ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function checkContinuousAbsent() {
  const conn = await pool.getConnection();
  try {
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 2);

    const [lawyers] = await conn.execute(
      "SELECT id, name FROM lawyers WHERE status = '可接案'",
    );

    const triggered = [];

    for (const lawyer of lawyers) {
      let absentDays = 0;
      const dates = [];

      for (let i = 0; i < 3; i++) {
        const checkDate = new Date(threeDaysAgo);
        checkDate.setDate(threeDaysAgo.getDate() + i);
        const dateStr = checkDate.toISOString().split("T")[0];
        const dayOfWeek = checkDate.getDay();

        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        const [schedules] = await conn.execute(
          "SELECT id FROM schedules WHERE lawyer_id = ? AND schedule_date = ? AND status = '正常'",
          [lawyer.id, dateStr],
        );

        const hasSchedule = schedules.length > 0;
        if (!hasSchedule && dayOfWeek >= 1 && dayOfWeek <= 5) {
          continue;
        }

        const [leaves] = await conn.execute(
          "SELECT id FROM leaves WHERE lawyer_id = ? AND leave_date = ? AND status = '已通过'",
          [lawyer.id, dateStr],
        );
        if (leaves.length > 0) continue;

        const [records] = await conn.execute(
          "SELECT id FROM attendance_records WHERE lawyer_id = ? AND DATE(check_in) = ?",
          [lawyer.id, dateStr],
        );

        if (records.length === 0) {
          absentDays++;
          dates.push(dateStr);
        }
      }

      if (absentDays >= 3) {
        const [[existing]] = await conn.execute(
          "SELECT id FROM reminders WHERE lawyer_id = ? AND type = '疑似脱岗' AND DATE(created_at) = ?",
          [lawyer.id, today.toISOString().split("T")[0]],
        );

        if (!existing) {
          await conn.execute(
            `INSERT INTO reminders (type, lawyer_id, title, content) 
             VALUES ('疑似脱岗', ?, ?, ?)`,
            [
              lawyer.id,
              `疑似脱岗提醒 - ${lawyer.name}`,
              `${lawyer.name} 连续3天应值班未签到，涉及日期：${dates.join("、")}，请核实。`,
            ],
          );
          triggered.push({
            lawyer_id: lawyer.id,
            lawyer_name: lawyer.name,
            dates,
          });
        }
      }
    }

    return { triggered_count: triggered.length, triggered };
  } finally {
    conn.release();
  }
}

async function checkMonthlyLate(month) {
  const conn = await pool.getConnection();
  try {
    const [year, monthNum] = month.split("-").map(Number);
    const startDate = `${year}-${monthNum.toString().padStart(2, "0")}-01`;
    const endDate = new Date(year, monthNum, 0).toISOString().split("T")[0];

    const [lawyers] = await conn.execute("SELECT id, name FROM lawyers");

    const triggered = [];

    for (const lawyer of lawyers) {
      const [records] = await conn.execute(
        `SELECT COUNT(*) as late_count FROM attendance_records 
         WHERE lawyer_id = ? AND DATE(check_in) BETWEEN ? AND ? AND is_late = 1`,
        [lawyer.id, startDate, endDate],
      );

      const lateCount = records[0].late_count;

      if (lateCount > 3) {
        const [[existing]] = await conn.execute(
          "SELECT id FROM reminders WHERE lawyer_id = ? AND type = '考勤异常' AND related_month = ?",
          [lawyer.id, month],
        );

        if (!existing) {
          await conn.execute(
            `INSERT INTO reminders (type, lawyer_id, title, content, related_month) 
             VALUES ('考勤异常', ?, ?, ?, ?)`,
            [
              lawyer.id,
              `考勤异常提醒 - ${lawyer.name}`,
              `${lawyer.name} 在 ${month} 月迟到 ${lateCount} 次，超过3次，请关注。`,
              month,
            ],
          );
          triggered.push({
            lawyer_id: lawyer.id,
            lawyer_name: lawyer.name,
            late_count: lateCount,
          });
        }
      }
    }

    return { month, triggered_count: triggered.length, triggered };
  } finally {
    conn.release();
  }
}

module.exports = router;
module.exports.checkContinuousAbsent = checkContinuousAbsent;
module.exports.checkMonthlyLate = checkMonthlyLate;
