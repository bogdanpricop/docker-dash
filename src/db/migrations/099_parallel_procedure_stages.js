'use strict';

exports.up = function (db) {
  const addColumn = sql => {
    try { db.exec(sql); } catch (err) {
      if (!String(err.message || '').includes('duplicate column name')) throw err;
    }
  };

  addColumn('ALTER TABLE procedures ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 4');
  addColumn('ALTER TABLE procedure_runs ADD COLUMN current_stage INTEGER NOT NULL DEFAULT 0');
  addColumn("ALTER TABLE procedure_runs ADD COLUMN step_results_json TEXT NOT NULL DEFAULT '[]'");
};
