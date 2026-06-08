const { pool } = require("./db");
const {
  checkContinuousAbsent,
  checkMonthlyLate,
} = require("./routes/reminders");

let checkOutTimer = null;
let absentTimer = null;
let lateTimer = null;

async function markAbnormalCheckOut() {
  const conn = await pool.getConnection();
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    const [records] = await conn.execute(
      `SELECT id, lawyer_id, check_in FROM attendance_records 
       WHERE DATE(check_in) = ? AND check_out IS NULL AND status = '正常'`,
      [yesterdayStr],
    );

    let count = 0;
    for (const record of records) {
      await conn.execute(
        `UPDATE attendance_records SET status = '异常未签退', remarks = ? WHERE id = ?`,
        ["系统自动标记：次日凌晨未签退", record.id],
      );
      count++;
    }

    console.log(`[定时任务] 异常未签退检查完成，标记 ${count} 条记录`);
    return { count, date: yesterdayStr };
  } catch (e) {
    console.error("[定时任务] 异常未签退检查失败:", e.message);
    throw e;
  } finally {
    conn.release();
  }
}

function getMsUntilNextRun(hour, minute = 0) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function startScheduler() {
  const checkOutDelay = getMsUntilNextRun(0, 30);
  console.log(
    `[定时任务] 异常未签退检查将在 ${Math.round(checkOutDelay / 60000)} 分钟后首次执行`,
  );

  checkOutTimer = setTimeout(() => {
    markAbnormalCheckOut().catch(console.error);
    checkOutTimer = setInterval(
      () => {
        markAbnormalCheckOut().catch(console.error);
      },
      24 * 60 * 60 * 1000,
    );
  }, checkOutDelay);

  const absentDelay = getMsUntilNextRun(8, 0);
  console.log(
    `[定时任务] 疑似脱岗检查将在 ${Math.round(absentDelay / 60000)} 分钟后首次执行`,
  );

  absentTimer = setTimeout(() => {
    checkContinuousAbsent().catch(console.error);
    absentTimer = setInterval(
      () => {
        checkContinuousAbsent().catch(console.error);
      },
      24 * 60 * 60 * 1000,
    );
  }, absentDelay);

  const lateDelay = getMsUntilNextRun(9, 0);
  console.log(
    `[定时任务] 月度迟到检查将在 ${Math.round(lateDelay / 60000)} 分钟后首次执行`,
  );

  lateTimer = setTimeout(() => {
    const month = new Date().toISOString().substring(0, 7);
    checkMonthlyLate(month).catch(console.error);
    lateTimer = setInterval(
      () => {
        const month = new Date().toISOString().substring(0, 7);
        checkMonthlyLate(month).catch(console.error);
      },
      24 * 60 * 60 * 1000,
    );
  }, lateDelay);

  console.log("[定时任务] 考勤定时任务已启动");
}

function stopScheduler() {
  if (checkOutTimer) {
    clearTimeout(checkOutTimer);
    clearInterval(checkOutTimer);
    checkOutTimer = null;
  }
  if (absentTimer) {
    clearTimeout(absentTimer);
    clearInterval(absentTimer);
    absentTimer = null;
  }
  if (lateTimer) {
    clearTimeout(lateTimer);
    clearInterval(lateTimer);
    lateTimer = null;
  }
  console.log("[定时任务] 考勤定时任务已停止");
}

module.exports = {
  startScheduler,
  stopScheduler,
  markAbnormalCheckOut,
  checkContinuousAbsent,
  checkMonthlyLate,
};
