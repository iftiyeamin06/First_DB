// database.js
require('dotenv').config();
const mysql = require('mysql2');

// Use connection pool for better performance
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD,
  database: 'my_store',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const promisePool = pool.promise();

// Test connection
pool.getConnection((err, connection) => {
  if (err) {
    console.error('Error connecting to MySQL:', err.message);
    return;
  }
  console.log('Successfully connected to the MySQL Database.');
  connection.release();
});

// Export the promise-based pool for modern async/await usage
module.exports = promisePool;