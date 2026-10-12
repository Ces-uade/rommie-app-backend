const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/', async (req, res) => {
  const houseId = req.query.houseId || req.query.house_id;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required', message: 'houseId is required' });
  }

  const { data: periods, error } = await supabase
    .from('periods')
    .select('*')
    .eq('house_id', houseId)
    .order('year', { ascending: false })
    .order('month', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(400).json({ error: error.message, message: error.message });
  }

  return res.status(200).json(periods || []);
});

router.post('/:id/close', async (req, res) => {
  const { id } = req.params;
  const { houseId, newMonth, newYear } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'id del período es requerido' });
  }

  // 1. Obtener el período que se solicita cerrar
  const { data: periodToClose, error: fetchError } = await supabase
    .from('periods')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return res.status(400).json({ error: fetchError.message, message: fetchError.message });
  }

  if (!periodToClose) {
    return res.status(404).json({ error: 'Período no encontrado', message: 'Período no encontrado' });
  }

  const targetHouseId = houseId || periodToClose.house_id;

  // 2. Determinar o calcular newMonth y newYear
  let parsedMonth;
  let parsedYear;

  if (newMonth === undefined || newYear === undefined) {
    // Si no se envían, calcula automáticamente el mes siguiente al período cerrado
    if (periodToClose.month === 12) {
      parsedMonth = 1;
      parsedYear = periodToClose.year + 1;
    } else {
      parsedMonth = periodToClose.month + 1;
      parsedYear = periodToClose.year;
    }
  } else {
    parsedMonth = parseInt(newMonth, 10);
    parsedYear = parseInt(newYear, 10);

    if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
      return res.status(400).json({ error: 'newMonth debe ser un entero entre 1 y 12' });
    }

    if (isNaN(parsedYear)) {
      return res.status(400).json({ error: 'newYear debe ser un número válido' });
    }
  }

  // Validación: que no se cree un nuevo período con el mismo month y year que el período cerrado
  if (parsedMonth === periodToClose.month && parsedYear === periodToClose.year) {
    const msg = 'El nuevo período no puede tener el mismo mes y año que el período cerrado';
    return res.status(400).json({ error: msg, message: msg });
  }

  // 3. Cerrar el período puntual y garantizar que todos los períodos abiertos de esa casa queden cerrados
  const { error: updateError } = await supabase
    .from('periods')
    .update({ is_closed: true })
    .eq('house_id', targetHouseId)
    .eq('is_closed', false);

  if (updateError) {
    return res.status(400).json({ error: updateError.message });
  }

  // Asegurar que si el período id ya estaba cerrado previamente, no genere inconsistencia
  await supabase
    .from('periods')
    .update({ is_closed: true })
    .eq('id', id);

  // 4. Crear nuevo período
  const { data: newPeriod, error: insertError } = await supabase
    .from('periods')
    .insert({
      house_id: targetHouseId,
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
