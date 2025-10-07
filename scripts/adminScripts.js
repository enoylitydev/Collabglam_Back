// scripts/initAdmin.js
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/admin');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error('Set ADMIN_EMAIL & ADMIN_PASSWORD in .env');
    }

    const exists = await Admin.findOne({ email: ADMIN_EMAIL.toLowerCase() });
    if (exists) {
      console.log('✅ Admin already initialised');
      return process.exit(0);
    }

    await Admin.create({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    console.log('🎉 Admin user seeded successfully');
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
})();
