// database.js
require('dotenv').config();
const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD,
  database: 'my_store'
});

connection.connect(err => {
  if (err) {
    console.error('Error connecting to MySQL:', err.message);
    return;
  }
  console.log('Successfully connected to the MySQL Database.');
});

// This is the most important part! 
// It allows index.js to "see" this connection.
module.exports = connection;