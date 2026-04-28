const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./DB/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for simplicity in this local project
}));
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Limit payload size
app.use(express.static(__dirname)); // Serve static files from current directory

// Rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 1000, 
    message: 'Too many requests'
});
app.use(limiter);

// Helper for logging
async function logAction(productId, type, details, qty = 0) {
    try {
        await db.query('INSERT INTO logs (product_id, action_type, details, quantity_changed) VALUES (?, ?, ?, ?)', 
            [productId, type, details, qty]);
    } catch (err) { console.error("Logging failed:", err); }
}

async function ensureBatchTables() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS stock_in (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            product_id INT NOT NULL,
            supplier_name VARCHAR(255) NULL,
            batch_number VARCHAR(100) NULL,
            quantity INT NOT NULL,
            cost_price DECIMAL(12,2) NOT NULL,
            selling_price DECIMAL(12,2) NOT NULL,
            received_date DATE NOT NULL,
            notes TEXT NULL,
            created_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_stock_in_product (product_id)
        )
    `);

    const [stockInCols] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_in'
    `);
    const stockInColumnSet = new Set(stockInCols.map(r => r.COLUMN_NAME));
    if (!stockInColumnSet.has('expiry_date')) {
        await db.query('ALTER TABLE stock_in ADD COLUMN expiry_date DATE NULL AFTER batch_number');
    }

    await db.query(`
        CREATE TABLE IF NOT EXISTS stock_out (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            product_id INT NOT NULL,
            stock_in_id BIGINT NULL,
            quantity INT NOT NULL,
            sale_price DECIMAL(12,2) NULL,
            reason ENUM('sale','donation','damaged','transfer','adjustment') NOT NULL DEFAULT 'sale',
            reference_no VARCHAR(100) NULL,
            out_date DATE NOT NULL,
            notes TEXT NULL,
            created_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_stock_out_product (product_id)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS inventory (
            product_id INT PRIMARY KEY,
            current_quantity INT NOT NULL DEFAULT 0,
            average_cost_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
            current_selling_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
            total_cost_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            total_selling_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
            low_stock BOOLEAN NOT NULL DEFAULT FALSE,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS inventory_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            product_id INT NOT NULL,
            action_type VARCHAR(50) NOT NULL,
            details TEXT NULL,
            quantity_changed INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function recalcAllInventory() {
    const [products] = await db.query('SELECT id FROM products');
    for (const product of products) {
        await recalcInventory(product.id);
    }
}

async function getColumnSet(tableName) {
    const [rows] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `, [tableName]);
    return new Set(rows.map(r => r.COLUMN_NAME));
}

async function recalcInventory(productId) {
    const [productRows] = await db.query('SELECT id, price, stock FROM products WHERE id = ?', [productId]);
    if (!productRows.length) return;

    const [inRows] = await db.query(
        'SELECT COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(quantity * cost_price),0) AS cost_value FROM stock_in WHERE product_id = ?',
        [productId]
    );
    const [outRows] = await db.query(
        'SELECT COALESCE(SUM(quantity),0) AS qty_out FROM stock_out WHERE product_id = ?',
        [productId]
    );

    const receivedQty = Number(inRows[0].qty || 0);
    const soldQty = Number(outRows[0].qty_out || 0);
    
    // Fallback: If no stock movements exist, use the manual stock/price from products table
    const currentQuantity = (receivedQty === 0 && soldQty === 0) 
        ? Number(productRows[0].stock || 0) 
        : (receivedQty - soldQty);
        
    // Improved fallback: if avg cost calculates to 0 but base price is not 0, use base price
    let avgCost = receivedQty > 0 
        ? Number(inRows[0].cost_value || 0) / receivedQty 
        : Number(productRows[0].price || 0);
    
    if (avgCost === 0 && Number(productRows[0].price) > 0) {
        avgCost = Number(productRows[0].price);
    }
        
    const sellingPrice = Number(productRows[0].price || 0);
    const totalCostValue = currentQuantity * avgCost;
    const totalSellingValue = currentQuantity * sellingPrice;
    const lowStock = currentQuantity < 5;

    // Keep products.stock in sync with the calculated quantity
    await db.query('UPDATE products SET stock = ? WHERE id = ?', [currentQuantity, productId]);

    await db.query(
        `INSERT INTO inventory
         (product_id, current_quantity, average_cost_price, current_selling_price, total_cost_value, total_selling_value, low_stock)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           current_quantity = VALUES(current_quantity),
           average_cost_price = VALUES(average_cost_price),
           current_selling_price = VALUES(current_selling_price),
           total_cost_value = VALUES(total_cost_value),
           total_selling_value = VALUES(total_selling_value),
           low_stock = VALUES(low_stock)`,
        [productId, currentQuantity, avgCost.toFixed(2), sellingPrice.toFixed(2), totalCostValue.toFixed(2), totalSellingValue.toFixed(2), lowStock ? 1 : 0]
    );
}

// Authentication middleware
const authenticate = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret-key');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(403).json({ error: 'Invalid token' });
    }
};

// 0. Fetch logs
app.get('/logs', authenticate, async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT l.*, p.name as product_name, p.item_code 
            FROM logs l 
            LEFT JOIN products p ON l.product_id = p.id 
            ORDER BY l.timestamp DESC LIMIT 100
        `);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 1. Fetch all categories
app.get('/categories', async (req, res) => {
    try {
        const { search } = req.query;
        let sql = 'SELECT * FROM categories';
        let params = [];

        if (search) {
            sql += ' WHERE name LIKE ? OR prefix LIKE ?';
            params.push(`%${search}%`, `%${search}%`);
        }

        const [results] = await db.query(sql, params);
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 2. Create a new category
app.post('/categories', authenticate, async (req, res) => {
    const { name, prefix } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    const finalPrefix = prefix ? prefix.toUpperCase() : name.substring(0, 3).toUpperCase();
    try {
        const [result] = await db.query('INSERT INTO categories (name, prefix) VALUES (?, ?)', [name, finalPrefix]);
        res.json({ message: 'Category created!', id: result.insertId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});
// 1. GET ALL PRODUCTS
app.get('/products', async (req, res) => {
    try {
        const { search, category_id } = req.query;
        let sql = `
            SELECT p.*, c.name as category_name, 
                   i.current_quantity, i.average_cost_price, i.current_selling_price, i.total_cost_value, i.total_selling_value, i.low_stock,
                   (SELECT batch_number FROM stock_in WHERE product_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_batch
            FROM products p 
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN inventory i ON i.product_id = p.id
        `;
        let params = [];
        let conditions = [];

        if (search) {
            conditions.push('(p.name LIKE ? OR p.item_code LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        
        if (category_id && category_id !== 'all') {
            conditions.push('p.category_id = ?');
            params.push(category_id);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        
        sql += ' ORDER BY p.created_at DESC';

        const [results] = await db.query(sql, params);
        res.json(results.map(row => ({
            ...row,
            current_selling_price: row.current_selling_price ?? row.price ?? 0,
            average_cost_price: row.average_cost_price ?? row.price ?? 0,
            current_quantity: row.current_quantity ?? row.stock ?? 0,
            total_cost_value: row.total_cost_value ?? (Number(row.stock || 0) * Number(row.price || 0)),
            total_selling_value: row.total_selling_value ?? (Number(row.stock || 0) * Number(row.price || 0)),
            combined_id: `${row.category_id || ''}${String(row.id).padStart(3, '0')}`
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 2. GET STATS (The math engine)
app.get('/stats', async (req, res) => {
    try {
        const [results] = await db.query(`
            SELECT 
                COUNT(*) as totalItems,
                COALESCE(SUM(price * stock), 0) as totalValue,
                COUNT(CASE WHEN stock < 5 THEN 1 END) as lowStockCount
            FROM products
        `);

        const [categoryBreakdown] = await db.query(`
            SELECT c.name, COALESCE(SUM(p.price * p.stock), 0) as value 
            FROM categories c 
            LEFT JOIN products p ON c.id = p.category_id 
            GROUP BY c.id, c.name
        `);

        res.json({
            totalItems: results[0].totalItems || 0,
            totalValue: parseFloat(results[0].totalValue || 0),
            lowStockCount: results[0].lowStockCount || 0,
            categoryBreakdown: categoryBreakdown.map(item => ({
                name: item.name,
                value: parseFloat(item.value || 0)
            }))
        });
    } catch (err) {
        console.error("STATS_FETCH_ERROR:", err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});
// NEW: ADMIN LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Login attempt for user: ${username}`);
    try {
        const [rows] = await db.query('SELECT * FROM admin_users WHERE username = ?', [username]);
        if (rows.length === 0) {
            console.log('Login failed: User not found');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = rows[0];
        
        // Robust password check: handle both hashed and plain text (for initial setup)
        let isValid = false;
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            isValid = await bcrypt.compare(password, user.password);
        } else {
            isValid = (password === user.password);
            // Auto-migrate to hash if it was plain text
            if (isValid) {
                const hashedPassword = await bcrypt.hash(password, 10);
                await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
                console.log('User password migrated to hash');
            }
        }

        if (!isValid) {
            console.log('Login failed: Incorrect password');
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate JWT
        const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET || 'secret-key', { expiresIn: '1h' });
        console.log('Login successful');
        res.json({ success: true, token, username: user.username });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// NEW: ADMIN ADVANCED STATS (Protected)
app.get('/admin/stats', authenticate, async (req, res) => {
    try {
        const queries = {
            categoryCount: 'SELECT COUNT(*) as count FROM categories',
            outOfStock: 'SELECT COUNT(*) as count FROM products WHERE stock = 0',
            topValueProducts: 'SELECT name, (price * stock) as total_value FROM products ORDER BY total_value DESC LIMIT 5',
            inventoryHealth: 'SELECT name, stock FROM products WHERE stock < 3'
        };
        const results = {};
        for (const key in queries) {
            const [rows] = await db.query(queries[key]);
            results[key] = rows;
        }
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. CREATE OR UPDATE PRODUCT (Upsert)
app.post('/products', authenticate, async (req, res) => {
    const { name, price, stock, category_id } = req.body;
    
    // Improved validation: check for null/undefined/empty string instead of falsy which catches 0
    if (!name || price === undefined || price === null || price === '' || 
        stock === undefined || stock === null || stock === '' || !category_id) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    const normalizedSearchName = name.replace(/\s+/g, '').toLowerCase();

    try {
        const [existing] = await db.query(
            'SELECT id, stock, price, name FROM products WHERE LOWER(REPLACE(name, " ", "")) = ?', 
            [normalizedSearchName]
        );

        if (existing.length > 0) {
            const product = existing[0];
            const newStock = Number(product.stock) + Number(stock);
            
            if (Number(price) !== Number(product.price)) {
                await db.query('UPDATE products SET price = ?, previous_price = ?, stock = ?, category_id = ? WHERE id = ?', 
                    [price, product.price, newStock, category_id, product.id]);
                await logAction(product.id, 'PRICE_CHANGE', `Price changed from $${product.price} to $${price} (during upsert)`);
            } else {
                await db.query('UPDATE products SET stock = ?, category_id = ? WHERE id = ?', 
                    [newStock, category_id, product.id]);
            }

            // Create stock_in record for the additional stock to keep batch system in sync
            await db.query(
                `INSERT INTO stock_in (product_id, quantity, cost_price, selling_price, received_date, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [product.id, Number(stock), price, price, new Date().toISOString().slice(0, 10), 'Added via quick-entry upsert', req.user.id]
            );

            await recalcInventory(product.id);
            await logAction(product.id, 'INVENTORY_CHANGE', `Added ${stock} units via quick-entry`, stock);
            res.json({ message: `Existing product "${product.name}" updated!`, updated: true });
        } else {
            const [catResult] = await db.query('SELECT id, prefix FROM categories WHERE id = ?', [category_id]);
            if (catResult.length === 0) return res.status(400).json({ error: "Invalid Category" });
            
            const prefix = catResult[0].prefix;
            
            const [maxResult] = await db.query(
                'SELECT MAX(CAST(SUBSTRING(item_code, LENGTH(?) + 2) AS UNSIGNED)) as maxVal FROM products WHERE category_id = ?',
                [prefix, category_id]
            );
            
            const maxVal = maxResult[0].maxVal !== null ? maxResult[0].maxVal : 0;
            const nextNum = String(maxVal + 1).padStart(3, '0');
            const itemCode = `${prefix}-${nextNum}`;

            const [result] = await db.query('INSERT INTO products (name, price, stock, category_id, item_code) VALUES (?, ?, ?, ?, ?)', [name, price, stock, category_id, itemCode]);
            const productId = result.insertId;

            // Create initial stock_in record
            await db.query(
                `INSERT INTO stock_in (product_id, quantity, cost_price, selling_price, received_date, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [productId, Number(stock), price, price, new Date().toISOString().slice(0, 10), 'Initial stock on creation', req.user.id]
            );

            await recalcInventory(productId);
            await logAction(productId, 'CREATE', `New product created with initial stock: ${stock}`, stock);
            res.json({ message: 'Product added!', itemCode });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// 4. STOCK IN (Update stock by item_code)
app.post('/stock-in', authenticate, async (req, res) => {
    const { item_code, quantity, cost_price, selling_price, supplier_name, batch_number, expiry_date, received_date, notes } = req.body;
    if (!item_code || !quantity) return res.status(400).json({ error: 'Product and quantity are required' });
    try {
        const [existing] = await db.query('SELECT id, stock, name, price FROM products WHERE item_code = ?', [item_code]);
        if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });

        const resolvedCostPrice = cost_price !== undefined && cost_price !== null && cost_price !== ''
            ? Number(cost_price)
            : Number(existing[0].price || 0);
        const resolvedSellingPrice = selling_price !== undefined && selling_price !== null && selling_price !== ''
            ? Number(selling_price)
            : Number(existing[0].price || 0);

        const stockInCols = await getColumnSet('stock_in');
        if (stockInCols.has('expiry_date')) {
            await db.query(
                `INSERT INTO stock_in
                 (product_id, supplier_name, batch_number, expiry_date, quantity, cost_price, selling_price, received_date, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    existing[0].id,
                    supplier_name || null,
                    batch_number || null,
                    expiry_date || null,
                    Number(quantity),
                    resolvedCostPrice,
                    resolvedSellingPrice,
                    received_date || new Date().toISOString().slice(0, 10),
                    notes || null,
                    req.user.id
                ]
            );
        } else {
            await db.query(
                `INSERT INTO stock_in
                 (product_id, supplier_name, batch_number, quantity, cost_price, selling_price, received_date, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    existing[0].id,
                    supplier_name || null,
                    batch_number || null,
                    Number(quantity),
                    resolvedCostPrice,
                    resolvedSellingPrice,
                    received_date || new Date().toISOString().slice(0, 10),
                    notes || null,
                    req.user.id
                ]
            );
        }

        const newStock = Number(existing[0].stock || 0) + Number(quantity);
        await db.query('UPDATE products SET stock = ?, price = ? WHERE id = ?', [newStock, resolvedSellingPrice, existing[0].id]);
        await recalcInventory(existing[0].id);
        await logAction(existing[0].id, 'STOCK_IN', `Received ${quantity} units of ${existing[0].name} at cost ${resolvedCostPrice}`, quantity);
        res.json({ success: true, message: 'Stock batch added!', newStock });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// UPDATE
app.put('/products/:id', authenticate, async (req, res) => {
    const { name, price, stock, category_id } = req.body;
    if (!name || price === undefined || price === null || price === '' || 
        stock === undefined || stock === null || stock === '') {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        const [existing] = await db.query('SELECT price, stock, category_id FROM products WHERE id = ?', [req.params.id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
        
        const oldPrice = existing[0].price;
        const oldStock = existing[0].stock;
        const oldCatId = existing[0].category_id;
        const stockDiff = Number(stock) - Number(oldStock);

        let sql = 'UPDATE products SET name = ?, price = ?, stock = ?';
        let params = [name, price, stock];

        if (category_id && Number(category_id) !== Number(oldCatId)) {
            sql += ', category_id = ?';
            params.push(category_id);
        }

        if (Number(price) !== Number(oldPrice)) {
            sql += ', previous_price = ?';
            params.push(oldPrice);
        }

        sql += ' WHERE id = ?';
        params.push(req.params.id);

        await db.query(sql, params);

        if (stockDiff !== 0) {
            // Record manual adjustment in stock_in or stock_out to keep sync
            if (stockDiff > 0) {
                await db.query(
                    `INSERT INTO stock_in (product_id, quantity, cost_price, selling_price, received_date, notes, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [req.params.id, stockDiff, price, price, new Date().toISOString().slice(0, 10), 'Manual adjustment (increase)', req.user.id]
                );
            } else {
                await db.query(
                    `INSERT INTO stock_out (product_id, quantity, sale_price, reason, out_date, notes, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [req.params.id, Math.abs(stockDiff), price, 'adjustment', new Date().toISOString().slice(0, 10), 'Manual adjustment (decrease)', req.user.id]
                );
            }
        }

        await recalcInventory(req.params.id);

        if (Number(price) !== Number(oldPrice)) {
            await logAction(req.params.id, 'PRICE_CHANGE', `Price edited from $${oldPrice} to $${price}`);
        }

        if (stockDiff !== 0) {
            await logAction(req.params.id, 'INVENTORY_CHANGE', `Manual stock adjustment: ${stockDiff > 0 ? '+' : ''}${stockDiff}`, stockDiff);
        }
        
        res.json({ message: 'Updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// DELETE
app.delete('/products/:id', authenticate, async (req, res) => {
    try {
        const [existing] = await db.query('SELECT name FROM products WHERE id = ?', [req.params.id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
        
        const prodName = existing[0].name;
        await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        await db.query('DELETE FROM inventory WHERE product_id = ?', [req.params.id]);
        await logAction(req.params.id, 'DELETE', `Product "${prodName}" was deleted`);
        res.json({ message: 'Deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});


 

ensureBatchTables()
    .then(recalcAllInventory)
    .then(() => {
        app.listen(port, () => {
            console.log(`🚀 Server running at http://localhost:${port}`);
        });
    })
    .catch(err => {
        console.error('Batch table bootstrap failed:', err.message);
        process.exit(1);
    });
