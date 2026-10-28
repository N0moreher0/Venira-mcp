const b = require("better-sqlite3");
const db = b("G:/Venira/data/venira.db");
console.log("TABLES:", db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name).join(", "));
const cols = db.prepare("PRAGMA table_info(project_tool_audit)").all().map(c => c.name).join(", ");
console.log("COLS:", cols);
const rows = db.prepare("SELECT * FROM project_tool_audit ORDER BY id DESC LIMIT 3").all();
console.log("ROWS:", JSON.stringify(rows, null, 2));
