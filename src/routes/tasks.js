const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

const FREQUENCIES = ['diaria', 'semanal', 'quincenal', 'mensual'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOUBLE_CLICK_WINDOW_MS = 2000;

const pad = (n) => String(n).padStart(2, '0');

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const addFrequency = (dateStr, frequency) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  if (frequency === 'mensual') {
    const targetMonth = date.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(targetMonth);
    date.setUTCDate(Math.min(d, lastDay));
  } else {
    const days = { diaria: 1, semanal: 7, quincenal: 15 }[frequency] || 1;
    date.setUTCDate(date.getUTCDate() + days);
  }

  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

const enrichTask = (task, roommates) => {
  const ids = Array.isArray(task.roommate_ids) ? task.roommate_ids : [];
  const assigneeId = ids[task.current_index];
  const assignee = (roommates || []).find((r) => r.id === assigneeId);

  return {
    id: task.id,
    house_id: task.house_id,
    name: task.name,
    frequency: task.frequency,
    roommate_ids: ids,
    current_index: task.current_index,
    current_assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    next_due_date: task.next_due_date,
    is_overdue: !!task.next_due_date && task.next_due_date < todayStr(),
  };
};

const fetchRoommates = (houseId) =>
  supabase.from('roommates').select('id, name').eq('house_id', houseId);

router.get('/', async (req, res) => {
  const { houseId } = req.query;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required', message: 'houseId is required' });
  }

  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('house_id', houseId)
    .order('next_due_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(400).json({ error: error.message, message: error.message });
  }

  const { data: roommates, error: rmError } = await fetchRoommates(houseId);

  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  return res.status(200).json((tasks || []).map((t) => enrichTask(t, roommates)));
});

router.post('/', async (req, res) => {
  const { houseId, name, frequency, roommateIds } = req.body;

  if (!houseId) {
    return res.status(400).json({ error: 'houseId is required', message: 'houseId is required' });
  }

  // Criterio 2: nombre 1-60 caracteres tras trim
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName.length < 1 || trimmedName.length > 60) {
    const msg = 'El nombre de la tarea debe tener entre 1 y 60 caracteres (sin contar espacios al inicio/final)';
    return res.status(400).json({ error: msg, message: msg });
  }

  // Criterio 3: frecuencia válida (case-insensitive)
  const normalizedFrequency = typeof frequency === 'string' ? frequency.trim().toLowerCase() : '';
  if (!FREQUENCIES.includes(normalizedFrequency)) {
    const msg = `La frecuencia debe ser una de: ${FREQUENCIES.join(', ')}`;
    return res.status(400).json({ error: msg, message: msg });
  }

  // Criterios 1 y 3: convivientes de la casa
  const { data: houseRoommates, error: rmError } = await fetchRoommates(houseId);

  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  if (!houseRoommates || houseRoommates.length < 2) {
    const msg = 'Se requieren al menos dos convivientes en la casa para crear tareas';
    return res.status(400).json({ error: msg, message: msg });
  }

  const uniqueIds = Array.isArray(roommateIds)
    ? [...new Set(roommateIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)))]
    : [];
  const houseRoommateIds = new Set(houseRoommates.map((r) => r.id));

  if (
    !Array.isArray(roommateIds) ||
    uniqueIds.length !== roommateIds.length ||
    uniqueIds.length < 2 ||
    !uniqueIds.every((id) => houseRoommateIds.has(id))
  ) {
    const msg = 'roommateIds debe contener al menos 2 IDs de convivientes distintos y válidos de esta casa';
    return res.status(400).json({ error: msg, message: msg });
  }

  // Criterio 4: primer turno y próxima fecha
  const { data: task, error: insertError } = await supabase
    .from('tasks')
    .insert({
      house_id: houseId,
      name: trimmedName,
      frequency: normalizedFrequency,
      roommate_ids: uniqueIds,
      current_index: 0,
      next_due_date: addFrequency(todayStr(), normalizedFrequency),
    })
    .select()
    .single();

  if (insertError) {
    return res.status(400).json({ error: insertError.message, message: insertError.message });
  }

  return res.status(201).json(enrichTask(task, houseRoommates));
});

router.get('/stats', async (req, res) => {
  const houseId = req.query.houseId || req.query.house_id;
  const periodId = req.query.periodId || req.query.period_id;

  if (!houseId || !periodId) {
    const msg = 'houseId y periodId son requeridos';
    return res.status(400).json({ error: msg, message: msg });
  }

  // 1. Consultar período
  const { data: period, error: periodError } = await supabase
    .from('periods')
    .select('id, month, year, is_closed, created_at')
    .eq('id', periodId)
    .eq('house_id', houseId)
    .maybeSingle();

  if (periodError) {
    return res.status(400).json({ error: periodError.message, message: periodError.message });
  }

  if (!period) {
    return res.status(404).json({ error: 'Período no encontrado', message: 'Período no encontrado' });
  }

  // 2. Roommates de la casa
  const { data: roommates, error: rmError } = await fetchRoommates(houseId);
  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  // 3. Tareas de la casa
  const { data: tasks, error: tasksError } = await supabase
    .from('tasks')
    .select('id')
    .eq('house_id', houseId);

  if (tasksError) {
    return res.status(400).json({ error: tasksError.message, message: tasksError.message });
  }

  const totalTasksCount = (tasks || []).length;

  // 4. task_completions filtrados estrictamente por house_id y period_id
  const { data: completions, error: compError } = await supabase
    .from('task_completions')
    .select('*')
    .eq('house_id', houseId)
    .eq('period_id', periodId);

  if (compError) {
    return res.status(400).json({ error: compError.message, message: compError.message });
  }

  const completionList = completions || [];
  const totalCompletedInPeriod = completionList.length;

  // Conteo por conviviente
  const countsByRoommate = {};
  completionList.forEach((c) => {
    if (c.roommate_id) {
      countsByRoommate[c.roommate_id] = (countsByRoommate[c.roommate_id] || 0) + 1;
    }
  });

  const stats = (roommates || []).map((rm) => {
    const completedCount = countsByRoommate[rm.id] || 0;
    const percentage =
      totalCompletedInPeriod > 0
        ? Number(((completedCount / totalCompletedInPeriod) * 100).toFixed(1))
        : 0;

    return {
      roommateId: rm.id,
      name: rm.name,
      completedCount,
      percentage,
    };
  });

  return res.status(200).json({
    period,
    totalTasksCount,
    totalCompletedInPeriod,
    stats,
  });
});

router.post('/:id/complete', async (req, res) => {
  const { id } = req.params;
  const { expectedIndex, periodId } = req.body || {};

  const { data: task, error: fetchError } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return res.status(400).json({ error: fetchError.message, message: fetchError.message });
  }

  if (!task) {
    return res.status(404).json({ error: 'Tarea no encontrada', message: 'Tarea no encontrada' });
  }

  const { data: roommates, error: rmError } = await fetchRoommates(task.house_id);

  if (rmError) {
    return res.status(400).json({ error: rmError.message, message: rmError.message });
  }

  // Criterio 8: idempotencia ante doble clic
  const staleIndex = expectedIndex !== undefined && task.current_index !== expectedIndex;
  const tooRecent =
    expectedIndex === undefined &&
    task.updated_at &&
    Date.now() - new Date(task.updated_at).getTime() < DOUBLE_CLICK_WINDOW_MS;

  if (staleIndex || tooRecent) {
    return res.status(200).json(enrichTask(task, roommates));
  }

  const ids = Array.isArray(task.roommate_ids) ? task.roommate_ids : [];
  if (ids.length === 0) {
    const msg = 'La tarea no tiene convivientes asignados';
    return res.status(400).json({ error: msg, message: msg });
  }

  // Identificar conviviente que acaba de cumplir su turno
  const completedRoommateId = ids[task.current_index];

  // Criterio 5: rotación circular y recálculo de fecha
  const newIndex = (task.current_index + 1) % ids.length;
  const today = todayStr();
  const base = task.next_due_date && task.next_due_date > today ? task.next_due_date : today;
  const newDueDate = addFrequency(base, task.frequency);

  // Update condicional: si otro request ya avanzó el turno, no se vuelve a avanzar
  const { data: updatedRows, error: updateError } = await supabase
    .from('tasks')
    .update({
      current_index: newIndex,
      next_due_date: newDueDate,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('current_index', task.current_index)
    .select();

  if (updateError) {
    return res.status(400).json({ error: updateError.message, message: updateError.message });
  }

  if (!updatedRows || updatedRows.length === 0) {
    const { data: current } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle();
    return res.status(200).json(enrichTask(current || task, roommates));
  }

  // Registrar en task_completions con período abierto
  if (completedRoommateId) {
    let activePeriod = null;
    if (periodId) {
      const { data: p } = await supabase
        .from('periods')
        .select('*')
        .eq('id', periodId)
        .eq('house_id', task.house_id)
        .eq('is_closed', false)
        .maybeSingle();
      if (p) activePeriod = p;
    }
    if (!activePeriod) {
      const { data: pList } = await supabase
        .from('periods')
        .select('*')
        .eq('house_id', task.house_id)
        .eq('is_closed', false)
        .order('created_at', { ascending: false })
        .limit(1);
      if (pList && pList.length > 0) activePeriod = pList[0];
    }

    if (activePeriod) {
      await supabase.from('task_completions').insert({
        house_id: task.house_id,
        task_id: task.id,
        period_id: activePeriod.id,
        roommate_id: completedRoommateId,
      });
    }
  }

  return res.status(200).json(enrichTask(updatedRows[0], roommates));
});

module.exports = router;
