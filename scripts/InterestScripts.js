// scripts/interestScripts.js
require('dotenv').config();
const mongoose = require('mongoose');
const Interest = require('../models/interest');     // ← uses models/interst
const interestsData = require('../data/interest'); // ← uses data/interest

async function populateInterests() {
  try {
    // 1) CONNECT TO MONGODB
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/Influencer';
    await mongoose.connect(uri);
    console.log('✔️ Connected to MongoDB');

    // Ensure indexes on the model (unique id & name)
    await Interest.init();

    // 2) OPTIONAL: Clear existing docs if you want a fresh slate
    // await Interest.deleteMany({});
    // console.log('🗑️ Cleared existing Interest documents');

    // 3) PREPARE DATA
    // data/interest exports an array directly ( [{ id, name }, ...] )
    const items = Array.isArray(interestsData)
      ? interestsData
      : (interestsData?.interests || []);

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No interests found in data/interest.js');
    }

    // 4) BULK UPSERT (safer than insertMany for re-runs)
    const ops = items.map(({ id, name }) => ({
      updateOne: {
        filter: { id },
        update: { $set: { name } },
        upsert: true,
      },
    }));

    const result = await Interest.bulkWrite(ops, { ordered: false });

    console.log('✅ Interests seed complete.');
    console.log({
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0,
      upserted:
        result.upsertedCount ||
        (result.upsertedIds ? Object.keys(result.upsertedIds).length : 0),
    });
  } catch (err) {
    console.error('❌ Error populating interests:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('🔒 MongoDB connection closed');
  }
}

populateInterests();
