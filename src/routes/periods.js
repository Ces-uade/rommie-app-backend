const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/:id/close', async (req, res) => {
  const { id } = req.params;
  const { houseId, newMonth, newYear } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'id del período es requerido' });
  }

  if (!houseId || newMonth === undefined || newYear === undefined) {
    return res.status(400).json({ error: 'houseId, newMonth y newYear son requeridos' });
  }

  const parsedMonth = parseInt(newMonth, 10);
  const parsedYear = parseInt(newYear, 10);

  if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return res.status(400).json({ error: 'newMonth debe ser un entero entre 1 y 12' });
  }

  if (isNaN(parsedYear)) {
    return res.status(400).json({ error: 'newYear debe ser un número válido' });
  }

  // 1. Cerrar período actual
  const { error: updateError } = await supabase
    .from('periods')
    .update({ is_closed: true })
    .eq('id', id);

  if (updateError) {
    return res.status(400).json({ error: updateError.message });
  }

  // 2. Crear nuevo período
  const { data: newPeriod, error: insertError } = await supabase
    .from('periods')
    .insert({
      house_id: houseId,
      month: parsedMonth,
      year: parsedYear,
      is_closed: false,
    })
    .select()
    .single();

  if (insertError) {
    return res.status(400).json({ error: insertError.message });
  }

  return res.status(200).json(newPeriod);
});

module.exports = router;
