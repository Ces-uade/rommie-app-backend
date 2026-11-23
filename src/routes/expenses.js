const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.post('/', async (req, res) => {
  const { periodId, paidBy, concept, amount, date, participants, category } = req.body || {};

  // Validación Criterio 1: category obligatoria y perteneciente a ['Fijo', 'Individual', 'Otro']
  const ALLOWED_CATEGORIES = {
    fijo: 'Fijo',
    individual: 'Individual',
    otro: 'Otro',
  };

  const normalizedCategory =
    typeof category === 'string'
      ? ALLOWED_CATEGORIES[category.trim().toLowerCase()]
      : null;

  if (!normalizedCategory) {
    return res.status(400).json({
      error: 'Debe seleccionar una categoría válida (Fijo, Individual u Otro)',
      message: 'Debe seleccionar una categoría válida (Fijo, Individual u Otro)',
    });
  }

  // Validations
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount debe ser un número mayor a 0' });
  }
  // Max 2 decimals
  if (Math.round(parsedAmount * 100) !== parsedAmount * 100) {
    return res.status(400).json({ error: 'amount no puede tener más de 2 decimales' });
  }
  if (!periodId || !paidBy || !concept || !date) {
    return res.status(400).json({ error: 'periodId, paidBy, concept y date son requeridos', message: 'periodId, paidBy, concept y date son requeridos' });
  }

  const trimmedConcept = typeof concept === 'string' ? concept.trim() : '';
  if (trimmedConcept.length < 1 || trimmedConcept.length > 100) {
    return res.status(400).json({
      error: 'El concepto debe tener entre 1 y 100 caracteres',
      message: 'El concepto debe tener entre 1 y 100 caracteres',
    });
  }

  // Validate active period and date range
  const { data: period, error: periodError } = await supabase
    .from('periods')
    .select('*')
    .eq('id', periodId)
    .single();

  if (periodError || !period) {
    return res.status(400).json({
      error: 'No se encontró el período especificado',
      message: 'No se encontró el período especificado',
    });
  }

  if (period.is_closed) {
    return res.status(400).json({
      error: 'El período se encuentra cerrado',
      message: 'El período se encuentra cerrado',
    });
  }

  // Validate minimum roommates querying the database (only active roommates)
  const houseId = req.body.houseId || req.body.house_id || period.house_id;
  const { count: roommateCount, error: countError } = await supabase
    .from('roommates')
    .select('*', { count: 'exact', head: true })
    .eq('house_id', houseId)
    .eq('is_active', true);

  if (countError) {
    return res.status(400).json({
      error: countError.message,
      message: countError.message,
    });
  }

  if (roommateCount < 2) {
    return res.status(400).json({
      error: 'Se necesitan al menos 2 integrantes para registrar gastos',
      message: 'Se necesitan al menos 2 integrantes para registrar gastos',
    });
  }

  const dateParts = String(date).split('T')[0].split('-');
  const expenseYear = parseInt(dateParts[0], 10);
  const expenseMonth = parseInt(dateParts[1], 10);

  if (isNaN(expenseYear) || isNaN(expenseMonth)) {
    return res.status(400).json({
      error: 'La fecha del gasto no es válida',
      message: 'La fecha del gasto no es válida',
    });
  }

  if (expenseYear < period.year || (expenseYear === period.year && expenseMonth < period.month)) {
    return res.status(400).json({
      error: 'La fecha del gasto no puede ser anterior al inicio del período abierto',
      message: 'La fecha del gasto no puede ser anterior al inicio del período abierto',
    });
  }

  if (expenseYear !== period.year || expenseMonth !== period.month) {
    return res.status(400).json({
      error: 'La fecha del gasto debe pertenecer al período abierto',
      message: 'La fecha del gasto debe pertenecer al período abierto',
    });
  }

  // Insert expense
  const { data: expense, error: expenseError } = await supabase
    .from('expenses')
    .insert({
      period_id: periodId,
      paid_by: paidBy,
      concept: trimmedConcept,
      amount: parsedAmount,
      date,
      category: normalizedCategory,
    })
    .select()
    .single();

  if (expenseError) {
    return res.status(400).json({ error: expenseError.message });
  }

  // Determine participants (if empty or not provided, default to all active roommates in the house)
  let activeParticipants = participants;
  if (!activeParticipants || !Array.isArray(activeParticipants) || activeParticipants.length === 0) {
    const { data: allHouseRoommates } = await supabase
      .from('roommates')
      .select('id')
      .eq('house_id', houseId)
      .eq('is_active', true);
    activeParticipants = (allHouseRoommates || []).map((r) => r.id);
  }

  // Fetch participants ordered by created_at
  const { data: roommates, error: roommatesError } = await supabase
    .from('roommates')
    .select('id, created_at')
    .in('id', activeParticipants)
    .order('created_at', { ascending: true });

  if (roommatesError) {
    return res.status(400).json({ error: roommatesError.message });
  }

  // Penny-accurate split
  const totalCents = Math.round(parsedAmount * 100);
  const n = roommates.length;
  const basePerParticipantCents = Math.floor(totalCents / n);
  const remainder = totalCents - basePerParticipantCents * n; // leftover pennies

  const splits = roommates.map((rm, index) => {
    const extraCent = index < remainder ? 1 : 0;
    const splitAmount = parseFloat(((basePerParticipantCents + extraCent) / 100).toFixed(2));
    return { expense_id: expense.id, roommate_id: rm.id, amount: splitAmount };
  });

  const { data: insertedSplits, error: splitsError } = await supabase
    .from('expense_splits')
    .insert(splits)
    .select();

  if (splitsError) {
    return res.status(400).json({ error: splitsError.message });
  }

  return res.status(201).json({
    expense: {
      ...expense,
      category: expense.category || 'Otro',
    },
    splits: insertedSplits,
  });
});

router.get('/', async (req, res) => {
  const { periodId, category } = req.query;

  if (!periodId) {
    return res.status(400).json({ error: 'periodId is required' });
  }

  let query = supabase
    .from('expenses')
    .select('*, roommates(id, name, is_active), expense_splits(*, roommates(id, name, is_active))')
    .eq('period_id', periodId)
    .order('date', { ascending: false });

  // Soporte opcional de query param category si es uno de los valores válidos
  const CATEGORY_MAP = {
    fijo: 'Fijo',
    individual: 'Individual',
    otro: 'Otro',
  };
  const filterCategory = typeof category === 'string' ? CATEGORY_MAP[category.trim().toLowerCase()] : null;

  if (filterCategory) {
    if (filterCategory === 'Otro') {
      query = query.or('category.eq.Otro,category.is.null');
    } else {
      query = query.eq('category', filterCategory);
    }
  }

  const { data, error } = await query;

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const formattedExpenses = (data || []).map((exp) => ({
    ...exp,
    category: exp.category || 'Otro',
  }));

  return res.status(200).json(formattedExpenses);
});

// PUT /api/expenses/:id (Criterios 1, 2, 3, 4, 5, 6, 10, 11, 12, 13 y 14)
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { concept, amount, date, category, paidBy, participants } = req.body || {};

  // 1. Buscar el gasto junto con su período y sus expense_splits actuales (incluyendo roommates)
  const { data: expense, error: fetchError } = await supabase
    .from('expenses')
    .select('*, periods(*), roommates(id, is_active), expense_splits(*, roommates(id, is_active))')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return res.status(400).json({ error: fetchError.message, message: fetchError.message });
  }

  if (!expense) {
    return res.status(404).json({ error: 'Gasto no encontrado', message: 'Gasto no encontrado' });
  }

  const period = expense.periods;
  if (!period) {
    return res.status(400).json({ error: 'No se encontró el período del gasto', message: 'No se encontró el período del gasto' });
  }

  // Criterio 1: Período cerrado no editable
  if (period.is_closed === true) {
    return res.status(400).json({
      error: 'No se pueden editar gastos de un período cerrado',
      message: 'No se pueden editar gastos de un período cerrado',
    });
  }

  // Criterio 3: Validaciones comunes
  // a) Concepto
  const trimmedConcept = typeof concept === 'string' ? concept.trim() : '';
  if (trimmedConcept.length < 1 || trimmedConcept.length > 100) {
    return res.status(400).json({
      error: 'El concepto debe tener entre 1 y 100 caracteres',
      message: 'El concepto debe tener entre 1 y 100 caracteres',
    });
  }

  // b) Categoría
  const ALLOWED_CATEGORIES = {
    fijo: 'Fijo',
    individual: 'Individual',
    otro: 'Otro',
  };
  const normalizedCategory =
    typeof category === 'string' ? ALLOWED_CATEGORIES[category.trim().toLowerCase()] : null;

  if (!normalizedCategory) {
    return res.status(400).json({
      error: 'Debe seleccionar una categoría válida (Fijo, Individual u Otro)',
      message: 'Debe seleccionar una categoría válida (Fijo, Individual u Otro)',
    });
  }

  // c) Fecha
  if (!date || typeof date !== 'string') {
    return res.status(400).json({
      error: 'La fecha del gasto no es válida',
      message: 'La fecha del gasto no es válida',
    });
  }

  const dateParts = String(date).split('T')[0].split('-');
  const expenseYear = parseInt(dateParts[0], 10);
  const expenseMonth = parseInt(dateParts[1], 10);

  if (isNaN(expenseYear) || isNaN(expenseMonth)) {
    return res.status(400).json({
      error: 'La fecha del gasto no es válida',
      message: 'La fecha del gasto no es válida',
    });
  }

  if (expenseYear !== period.year || expenseMonth !== period.month) {
    return res.status(400).json({
      error: 'La fecha del gasto debe pertenecer al período abierto',
      message: 'La fecha del gasto debe pertenecer al período abierto',
    });
  }

  const formattedDate = dateParts.join('-');

  // Criterio 6: Detectar si involucra un conviviente eliminado
  const currentSplits = expense.expense_splits || [];
  const payerIsInactive = expense.roommates?.is_active === false;
  const participantIsInactive = currentSplits.some((s) => s.roommates?.is_active === false);
  const hasInactiveRoommate = payerIsInactive || participantIsInactive;

  if (hasInactiveRoommate) {
    // Si intenta modificar amount, paidBy o participants a valores distintos de los actuales
    const currentAmount = parseFloat(expense.amount);
    const newAmount = amount !== undefined ? parseFloat(amount) : currentAmount;
    const amountChanged = Math.abs(newAmount - currentAmount) > 0.0001;

    const currentPayer = expense.paid_by;
    const newPayer = paidBy !== undefined ? paidBy : currentPayer;
    const payerChanged = newPayer !== currentPayer;

    let participantsChanged = false;
    if (participants !== undefined && Array.isArray(participants)) {
      const currentParticipantIds = [...new Set(currentSplits.map((s) => s.roommate_id))].sort();
      const newParticipantIds = [...new Set(participants)].sort();
      if (
        currentParticipantIds.length !== newParticipantIds.length ||
        !currentParticipantIds.every((val, idx) => val === newParticipantIds[idx])
      ) {
        participantsChanged = true;
      }
    }

    if (amountChanged || payerChanged || participantsChanged) {
      return res.status(400).json({
        error: 'Este gasto incluye un conviviente eliminado; solo se pueden editar concepto, fecha y categoría',
        message: 'Este gasto incluye un conviviente eliminado; solo se pueden editar concepto, fecha y categoría',
      });
    }

    // Solo actualizar concept, date y category
    const { error: updateError } = await supabase
      .from('expenses')
      .update({
        concept: trimmedConcept,
        date: formattedDate,
        category: normalizedCategory,
      })
      .eq('id', id);

    if (updateError) {
      return res.status(400).json({ error: updateError.message, message: updateError.message });
    }

    // Devolver el gasto actualizado con el mismo formato que GET
    const { data: updatedExpense, error: getError } = await supabase
      .from('expenses')
      .select('*, roommates(id, name, is_active), expense_splits(*, roommates(id, name, is_active))')
      .eq('id', id)
      .single();

    if (getError) {
      return res.status(400).json({ error: getError.message, message: getError.message });
    }

    return res.status(200).json({
      ...updatedExpense,
      category: updatedExpense.category || 'Otro',
    });
  }

  // hasInactiveRoommate === false: Puede editar amount, paidBy y participants
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount debe ser un número mayor a 0', message: 'amount debe ser un número mayor a 0' });
  }

  if (Math.round(parsedAmount * 100) !== parsedAmount * 100) {
    return res.status(400).json({ error: 'amount no puede tener más de 2 decimales', message: 'amount no puede tener más de 2 decimales' });
  }

  // Validar paidBy: conviviente activo de la casa
  if (!paidBy) {
    return res.status(400).json({ error: 'paidBy es requerido', message: 'paidBy es requerido' });
  }

  const { data: activeHouseRoommates, error: rmFetchError } = await supabase
    .from('roommates')
    .select('id, created_at')
    .eq('house_id', period.house_id)
    .eq('is_active', true);

  if (rmFetchError) {
    return res.status(400).json({ error: rmFetchError.message, message: rmFetchError.message });
  }

  const activeMap = new Map((activeHouseRoommates || []).map((r) => [r.id, r]));

  if (!activeMap.has(paidBy)) {
    return res.status(400).json({
      error: 'El pagador debe ser un conviviente activo de la casa',
      message: 'El pagador debe ser un conviviente activo de la casa',
    });
  }

  // Validar participants: array no vacío y todos activos
  const targetParticipants = Array.isArray(participants) && participants.length > 0
    ? [...new Set(participants)]
    : [];

  if (targetParticipants.length === 0) {
    return res.status(400).json({
      error: 'Debe seleccionar al menos un participante activo',
      message: 'Debe seleccionar al menos un participante activo',
    });
  }

  const allActive = targetParticipants.every((pId) => activeMap.has(pId));
  if (!allActive) {
    return res.status(400).json({
      error: 'Todos los participantes deben ser convivientes activos de la casa',
      message: 'Todos los participantes deben ser convivientes activos de la casa',
    });
  }

  // Criterio 4: Penny-accurate split
  const selectedRoommates = targetParticipants
    .map((pId) => activeMap.get(pId))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const totalCents = Math.round(parsedAmount * 100);
  const n = selectedRoommates.length;
  const basePerParticipantCents = Math.floor(totalCents / n);
  const remainder = totalCents - basePerParticipantCents * n;

  const newSplits = selectedRoommates.map((rm, index) => {
    const extraCent = index < remainder ? 1 : 0;
    const splitAmount = parseFloat(((basePerParticipantCents + extraCent) / 100).toFixed(2));
    return {
      expense_id: id,
      roommate_id: rm.id,
      amount: splitAmount,
    };
  });

  // Criterio 12: Backup previo y atomicidad
  const previousExpense = {
    concept: expense.concept,
    amount: expense.amount,
    date: expense.date,
    category: expense.category,
    paid_by: expense.paid_by,
  };

  const previousSplits = currentSplits.map((s) => ({
    expense_id: s.expense_id,
    roommate_id: s.roommate_id,
    amount: s.amount,
  }));

  // Actualizar gasto
  const { error: expUpdateErr } = await supabase
    .from('expenses')
    .update({
      concept: trimmedConcept,
      amount: parsedAmount,
      date: formattedDate,
      category: normalizedCategory,
      paid_by: paidBy,
    })
    .eq('id', id);

  if (expUpdateErr) {
    return res.status(400).json({ error: expUpdateErr.message, message: expUpdateErr.message });
  }

  // Borrar splits anteriores
  const { error: delSplitsErr } = await supabase
    .from('expense_splits')
    .delete()
    .eq('expense_id', id);

  if (delSplitsErr) {
    // Restaurar gasto anterior
    await supabase.from('expenses').update(previousExpense).eq('id', id);
    return res.status(500).json({ error: delSplitsErr.message, message: delSplitsErr.message });
  }

  // Insertar nuevos splits
  const { error: insSplitsErr } = await supabase
    .from('expense_splits')
    .insert(newSplits);

  if (insSplitsErr) {
    // Rollback: restaurar gasto y splits anteriores
    await supabase.from('expenses').update(previousExpense).eq('id', id);
    if (previousSplits.length > 0) {
      await supabase.from('expense_splits').insert(previousSplits);
    }
    return res.status(500).json({
      error: 'Error al actualizar las cuotas del gasto',
      message: insSplitsErr.message,
    });
  }

  // Obtener gasto final con joins
  const { data: finalExpense, error: finalError } = await supabase
    .from('expenses')
    .select('*, roommates(id, name, is_active), expense_splits(*, roommates(id, name, is_active))')
    .eq('id', id)
    .single();

  if (finalError) {
    return res.status(400).json({ error: finalError.message, message: finalError.message });
  }

  return res.status(200).json({
    ...finalExpense,
    category: finalExpense.category || 'Otro',
  });
});

// DELETE /api/expenses/:id (Criterios 1, 8, 9, 11, 12, 13 y 14)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: expense, error: fetchError } = await supabase
    .from('expenses')
    .select('id, period_id, periods(is_closed)')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    return res.status(400).json({ error: fetchError.message, message: fetchError.message });
  }

  if (!expense) {
    return res.status(404).json({ error: 'Gasto no encontrado', message: 'Gasto no encontrado' });
  }

  if (expense.periods?.is_closed === true) {
    return res.status(400).json({
      error: 'No se pueden eliminar gastos de un período cerrado',
      message: 'No se pueden eliminar gastos de un período cerrado',
    });
  }

  // Eliminar el gasto (expense_splits se borra en cascada por FK)
  const { error: deleteError } = await supabase
    .from('expenses')
    .delete()
    .eq('id', id);

  if (deleteError) {
    return res.status(500).json({ error: deleteError.message, message: deleteError.message });
  }

  return res.status(200).json({
    message: 'Gasto eliminado correctamente',
    id,
  });
});

module.exports = router;
