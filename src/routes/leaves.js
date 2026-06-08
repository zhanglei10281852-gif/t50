const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.post("/", async (req, res) => {
  const { lawyer_id, leave_date, time_slot, reason } = req.body;
  if (!lawyer_id || !leave_date || !reason) {
    return res.status(400).json({ error: "律师ID、请假日期、请假原因为必填" });
  }
  if (time_slot && !["上午", "下午", "全天"].includes(time_slot)) {
    return res.status(400).json({ error: "请假时段无效" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[lawyer]] = await conn.execute(
      "SELECT id FROM lawyers WHERE id = ?",
      [lawyer_id]
    );
    if (!lawyer) {
      await conn.rollback();
      return res.status(404).json({ error: "律师不存在" });
    }

    const [existing] = await conn.execute(
      "SELECT id FROM leaves WHERE lawyer_id = ? AND leave_date = ? AND time_slot = ? AND status != '已驳回'",
      [lawyer_id, leave_date, time_slot || "全天"]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json({ error: "该时段已有请假申请" });
    }

    const [result] = await conn.execute(
      `INSERT INTO leaves (lawyer_id, leave_date, time_slot, reason) 
       VALUES (?, ?, ?, ?)`,
      [lawyer_id, leave_date, time_slot || "全天", reason]
    );

    await conn.commit();
    res.status(201).json({ id: result.insertId, message: "请假申请提交成功" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/", async (req, res) => {
  const { lawyer_id, status, start_date, end_date, page = 1, size = 20 } = req.query;
  let where = [];
  let params = [];

  if (lawyer_id) {
    where.push("l.lawyer_id = ?");
    params.push(lawyer_id);
  }
  if (status) {
    where.push("l.status = ?");
    params.push(status);
  }
  if (start_date) {
    where.push("l.leave_date >= ?");
    params.push(start_date);
  }
  if (end_date) {
    where.push("l.leave_date <= ?");
    params.push(end_date);
  }

  const whereStr = where.length > 0 ? " WHERE " + where.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM leaves l${whereStr}`,
    params
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.query(
    `SELECT l.*, lw.name as lawyer_name, lw.license_no 
     FROM leaves l 
     LEFT JOIN lawyers lw ON l.lawyer_id = lw.id
     ${whereStr} 
     ORDER BY l.created_at DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    `SELECT l.*, lw.name as lawyer_name 
     FROM leaves l 
     LEFT JOIN lawyers lw ON l.lawyer_id = lw.id 
     WHERE l.id = ?`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: "请假记录不存在" });
  res.json(row);
});

router.put("/:id/approve", async (req, res) => {
  const { approver_id, approve_remark } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[leave]] = await conn.execute(
      "SELECT * FROM leaves WHERE id = ?",
      [req.params.id]
    );
    if (!leave) {
      await conn.rollback();
      return res.status(404).json({ error: "请假记录不存在" });
    }
    if (leave.status !== "待审批") {
      await conn.rollback();
      return res.status(400).json({ error: "该请假已审批" });
    }

    await conn.execute(
      `UPDATE leaves SET status = '已通过', approver_id = ?, approve_remark = ? WHERE id = ?`,
      [approver_id || null, approve_remark || null, req.params.id]
    );

    const [schedules] = await conn.execute(
      "SELECT id FROM schedules WHERE lawyer_id = ? AND schedule_date = ? AND time_slot = ?",
      [leave.lawyer_id, leave.leave_date, leave.time_slot]
    );
    if (schedules.length > 0) {
      for (const s of schedules) {
        await conn.execute(
          "UPDATE schedules SET status = '请假' WHERE id = ?",
          [s.id]
        );
      }
    }

    await conn.commit();
    res.json({ message: "请假审批通过" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.put("/:id/reject", async (req, res) => {
  const { approver_id, approve_remark } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[leave]] = await conn.execute(
      "SELECT * FROM leaves WHERE id = ?",
      [req.params.id]
    );
    if (!leave) {
      await conn.rollback();
      return res.status(404).json({ error: "请假记录不存在" });
    }
    if (leave.status !== "待审批") {
      await conn.rollback();
      return res.status(400).json({ error: "该请假已审批" });
    }

    await conn.execute(
      `UPDATE leaves SET status = '已驳回', approver_id = ?, approve_remark = ? WHERE id = ?`,
      [approver_id || null, approve_remark || null, req.params.id]
    );

    await conn.commit();
    res.json({ message: "请假已驳回" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.post("/:id/substitute", async (req, res) => {
  const { substitute_lawyer_id } = req.body;
  if (!substitute_lawyer_id) {
    return res.status(400).json({ error: "替班律师ID为必填" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[leave]] = await conn.execute(
      "SELECT * FROM leaves WHERE id = ?",
      [req.params.id]
    );
    if (!leave) {
      await conn.rollback();
      return res.status(404).json({ error: "请假记录不存在" });
    }
    if (leave.status !== "已通过") {
      await conn.rollback();
      return res.status(400).json({ error: "请假未通过，无法安排替班" });
    }

    const [[subLawyer]] = await conn.execute(
      "SELECT id, name FROM lawyers WHERE id = ?",
      [substitute_lawyer_id]
    );
    if (!subLawyer) {
      await conn.rollback();
      return res.status(404).json({ error: "替班律师不存在" });
    }

    const [result] = await conn.execute(
      `INSERT INTO substitutions 
       (leave_id, original_lawyer_id, substitute_lawyer_id, schedule_date, time_slot, status)
       VALUES (?, ?, ?, ?, ?, '待确认')`,
      [leave.id, leave.lawyer_id, substitute_lawyer_id, leave.leave_date, leave.time_slot]
    );

    await conn.commit();
    res.status(201).json({ id: result.insertId, message: "替班安排成功" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/substitutions/list", async (req, res) => {
  const { original_lawyer_id, substitute_lawyer_id, status, page = 1, size = 20 } = req.query;
  let where = [];
  let params = [];

  if (original_lawyer_id) {
    where.push("s.original_lawyer_id = ?");
    params.push(original_lawyer_id);
  }
  if (substitute_lawyer_id) {
    where.push("s.substitute_lawyer_id = ?");
    params.push(substitute_lawyer_id);
  }
  if (status) {
    where.push("s.status = ?");
    params.push(status);
  }

  const whereStr = where.length > 0 ? " WHERE " + where.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM substitutions s${whereStr}`,
    params
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.query(
    `SELECT s.*, 
            ol.name as original_lawyer_name, 
            sl.name as substitute_lawyer_name
     FROM substitutions s 
     LEFT JOIN lawyers ol ON s.original_lawyer_id = ol.id
     LEFT JOIN lawyers sl ON s.substitute_lawyer_id = sl.id
     ${whereStr} 
     ORDER BY s.created_at DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.put("/substitutions/:id/confirm", async (req, res) => {
  const [result] = await pool.execute(
    "UPDATE substitutions SET status = '已确认' WHERE id = ? AND status = '待确认'",
    [req.params.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "替班记录不存在或状态不支持确认" });
  }
  res.json({ message: "替班确认成功" });
});

module.exports = router;
