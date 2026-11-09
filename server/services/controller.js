'use strict';
/**
 * Antarmuka ke pengendali mesin (PLC). Server TIDAK pernah mengirim perintah START.
 * Perintah yang tersedia:
 *  - GRANT_PERMISSION  : mengizinkan operasi (operator tetap menekan tombol start sesuai prosedur)
 *  - REQUEST_STOP      : meminta penghentian terkendali, pengendali membalas setelah kondisi aman
 *  - REVOKE_PERMISSION : mencabut izin (tanpa memutus daya mendadak)
 * Perintah diantrekan di DB; perangkat lokal mengambil (polling) dan mengirim hasil.
 * Dalam mode simulasi, simulator berlangganan kejadian 'command'.
 */
function createQueueController(core) {
  const { db } = core;
  return {
    send(machineId, sessionId, type) {
      const id = core.uid();
      db.run('INSERT INTO controller_commands (id, machine_id, session_id, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, machineId, sessionId, type, 'PENDING', core.clock.now());
      // Dipancarkan setelah transaksi selesai agar penerima melihat data yang sudah tersimpan
      setImmediate(() => core.bus.emit('command', { id, machineId, sessionId, type }));
      return id;
    },
    pending(machineId) {
      const rows = db.all("SELECT * FROM controller_commands WHERE machine_id = ? AND status = 'PENDING' ORDER BY created_at", machineId);
      for (const r of rows) db.run("UPDATE controller_commands SET status = 'SENT', sent_at = ? WHERE id = ?", core.clock.now(), r.id);
      return rows;
    },
  };
}
module.exports = { createQueueController };
