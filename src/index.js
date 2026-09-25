const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const houseRoutes = require('./routes/houses');
const roommateRoutes = require('./routes/roommates');
const expenseRoutes = require('./routes/expenses');
const balanceRoutes = require('./routes/balances');
const paymentRoutes = require('./routes/payments');
const periodRoutes = require('./routes/periods');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/houses', houseRoutes);
app.use('/api/roommates', roommateRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/balances', balanceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/periods', periodRoutes);

app.get('/', (req, res) => {
  res.send('API running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
