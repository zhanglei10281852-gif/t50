const express = require("express");
const cors = require("cors");
const { initDb } = require("./db");
const { startScheduler } = require("./scheduler");
const applicantRoutes = require("./routes/applicants");
const caseRoutes = require("./routes/cases");
const lawyerRoutes = require("./routes/lawyers");
const attendanceRoutes = require("./routes/attendance");
const leaveRoutes = require("./routes/leaves");
const statisticsRoutes = require("./routes/statistics");
const reminderRoutes = require("./routes/reminders");

const app = express();
const PORT = 7290;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ service: "法律援助管理平台", version: "1.0.0" });
});

app.use("/api/applicants", applicantRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/lawyers", lawyerRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/statistics", statisticsRoutes);
app.use("/api/reminders", reminderRoutes);

async function start() {
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`法律援助平台启动成功，端口: ${PORT}`);
    startScheduler();
  });
}

start().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
