const db = require('./database');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

async function setup() {
    try {
        console.log('Starting database setup...');
        
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        const statements = schema.split(';').filter(s => s.trim() !== '');
        
        for (let statement of statements) {
            await db.query(statement);
        }
        console.log('Schema applied successfully.');

        // Check if admin exists
        const [rows] = await db.query('SELECT * FROM admin_users WHERE username = ?', ['admin']);
        if (rows.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await db.query('INSERT INTO admin_users (username, password) VALUES (?, ?)', ['admin', hashedPassword]);
            console.log('Default admin user created: admin / admin123');
        } else {
            console.log('Admin user already exists.');
        }

        console.log('Database setup complete.');
        process.exit(0);
    } catch (err) {
        console.error('Database setup failed:', err);
        process.exit(1);
    }
}

setup();
