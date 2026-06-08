const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "legal123",
  database: process.env.DB_NAME || "legal_aid",
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS applicants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        id_card VARCHAR(18) NOT NULL UNIQUE,
        gender ENUM('男','女') NOT NULL,
        phone VARCHAR(20),
        address VARCHAR(200),
        category ENUM('低保户','残疾人','老年人','未成年人','农民工','军人军属','其他') NOT NULL,
        income_level ENUM('无收入','低收入','一般'),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS lawyers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        license_no VARCHAR(30) NOT NULL UNIQUE,
        phone VARCHAR(20),
        firm VARCHAR(100) NOT NULL,
        speciality VARCHAR(50),
        status ENUM('可接案','案件中','休假') NOT NULL DEFAULT '可接案',
        case_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_no VARCHAR(20) NOT NULL UNIQUE,
        applicant_id INT NOT NULL,
        lawyer_id INT,
        case_type ENUM('民事','刑事','行政','劳动争议','婚姻家庭','其他') NOT NULL,
        description TEXT,
        status ENUM('待审批','已批准','已指派','办理中','已结案','已驳回') NOT NULL DEFAULT '待审批',
        approve_reason VARCHAR(500),
        reject_reason VARCHAR(500),
        result TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES applicants(id),
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lawyer_id INT NOT NULL,
        schedule_date DATE NOT NULL,
        time_slot ENUM('上午','下午','全天') NOT NULL DEFAULT '全天',
        start_time TIME NOT NULL DEFAULT '09:00:00',
        end_time TIME NOT NULL DEFAULT '17:00:00',
        status ENUM('正常','请假','替班') NOT NULL DEFAULT '正常',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id),
        UNIQUE KEY uk_lawyer_date_slot (lawyer_id, schedule_date, time_slot)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lawyer_id INT NOT NULL,
        schedule_id INT,
        check_in DATETIME NOT NULL,
        check_out DATETIME,
        work_hours DECIMAL(4,1) DEFAULT 0,
        is_late TINYINT(1) DEFAULT 0,
        is_early_leave TINYINT(1) DEFAULT 0,
        status ENUM('正常','异常未签退','请假') NOT NULL DEFAULT '正常',
        remarks VARCHAR(500),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id),
        FOREIGN KEY (schedule_id) REFERENCES schedules(id),
        INDEX idx_lawyer_date (lawyer_id, DATE(check_in))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leaves (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lawyer_id INT NOT NULL,
        leave_date DATE NOT NULL,
        time_slot ENUM('上午','下午','全天') NOT NULL DEFAULT '全天',
        reason VARCHAR(500) NOT NULL,
        status ENUM('待审批','已通过','已驳回') NOT NULL DEFAULT '待审批',
        approver_id INT,
        approve_remark VARCHAR(500),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS substitutions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        leave_id INT,
        original_lawyer_id INT NOT NULL,
        substitute_lawyer_id INT NOT NULL,
        schedule_date DATE NOT NULL,
        time_slot ENUM('上午','下午','全天') NOT NULL DEFAULT '全天',
        status ENUM('待确认','已确认','已取消') NOT NULL DEFAULT '待确认',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (leave_id) REFERENCES leaves(id),
        FOREIGN KEY (original_lawyer_id) REFERENCES lawyers(id),
        FOREIGN KEY (substitute_lawyer_id) REFERENCES lawyers(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type ENUM('疑似脱岗','考勤异常') NOT NULL,
        lawyer_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        content TEXT,
        related_month VARCHAR(7),
        is_read TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id),
        INDEX idx_lawyer_type (lawyer_id, type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS workload_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lawyer_id INT NOT NULL,
        record_month VARCHAR(7) NOT NULL,
        consultation_count INT DEFAULT 0,
        case_count INT DEFAULT 0,
        work_hours DECIMAL(6,1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id),
        UNIQUE KEY uk_lawyer_month (lawyer_id, record_month)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log("数据库表初始化完成");
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
