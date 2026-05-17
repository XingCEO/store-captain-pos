'use strict';

// Drizzle Kit config — used to generate Postgres migrations from
// src/db/schema.pg.js. SQLite remains the default dev/test backend
// via src/core/db.js; this config exists so the Postgres migration
// path can be developed and reviewed before infra is provisioned.

module.exports = {
  schema: './src/db/schema.pg.js',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/ulw',
  },
  strict: true,
  verbose: true,
};
