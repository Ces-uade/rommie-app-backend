const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { calculatePeriodBalances } = require('../utils/calculateBalances');

router.get('/', async (req, res) => {
  const { periodId, houseId } = req.query;

  if (!periodId || !houseId) {
    return res.status(400).json({ error: 'periodId and houseId are required' });
  }

  const { data: period, error: periodError } = await supabase
    .from('periods')
    .select('id, is_closed, closing_debts')
    .eq('id', periodId)
    .maybeSingle();

  if (periodError) {
    return res.status(400).json({ error: periodError.message });
  }

  let result;
  try {
    result = await calculatePeriodBalances(houseId, periodId);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const isClosed = !!(period && period.is_closed === true);
  const debts =
    isClosed && period.closing_debts !== null && period.closing_debts !== undefined
      ? period.closing_debts
      : result.debts;

  return res.status(200).json({ balances: result.balances, debts, is_closed: isClosed });
});

module.exports = router;
