# My Store Inventory Management System

A full-stack web application for managing store inventory with categories, products, and admin dashboard.

## Features

- Product inventory management with search and filtering
- Category management with guided workflow
- Real-time statistics
- Admin dashboard with advanced analytics
- Secure authentication with JWT
- Responsive web interface with user-friendly navigation

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: MySQL
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Security**: bcryptjs, JWT, Helmet, Rate Limiting

## Setup

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd First_DB
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Database Setup**
   - Create a MySQL database named `my_store`
   - Run the following SQL to create tables:
     ```sql
     CREATE TABLE categories (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(255) NOT NULL,
       prefix VARCHAR(10) NOT NULL UNIQUE
     ) AUTO_INCREMENT = 101;

     CREATE TABLE products (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(255) NOT NULL,
       price DECIMAL(10,2) NOT NULL,
       previous_price DECIMAL(10,2) DEFAULT NULL,
       stock INT NOT NULL,
       category_id INT,
       item_code VARCHAR(50),
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (category_id) REFERENCES categories(id)
     );

     CREATE TABLE logs (
       id INT AUTO_INCREMENT PRIMARY KEY,
       product_id INT,
       action_type ENUM('STOCK_IN', 'INVENTORY_CHANGE', 'PRICE_CHANGE', 'CREATE', 'DELETE') NOT NULL,
       details TEXT,
       quantity_changed INT DEFAULT 0,
       timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
     );

     -- Insert default admin user (password: admin123)
     INSERT INTO admin_users (username, password) VALUES ('admin', '$2a$10$example.hash.here');
     ```

4. **Environment Variables**
   - Copy `.env` and update `DB_PASSWORD` and `JWT_SECRET`

5. **Run the application**
   ```bash
   npm start
   ```

6. **Access the app**
   - Main Dashboard: http://localhost:3000/index.html
   - Admin Login: http://localhost:3000/login.html
   
   *Note: Always access through the `http://localhost` URL. Opening the `.html` files directly from your folder will cause the features to not work.*

## API Endpoints

### Categories
- `GET /categories` - Get all categories (supports query param: `?search=name`)
- `POST /categories` - Create new category

### Products
- `GET /products` - Get all products (supports query params: `?search=name&category_id=id`)
- `POST /products` - Add/update product
- `PUT /products/:id` - Update product
- `DELETE /products/:id` - Delete product

### Stats
- `GET /stats` - Get basic stats
- `GET /admin/stats` - Get advanced stats (requires auth)

### Auth
- `POST /login` - Admin login

## Security Features

- Password hashing with bcrypt
- JWT authentication
- Helmet security headers
- Rate limiting
- Input validation
- CORS enabled

## Development

- Uses MySQL connection pool
- Async/await for cleaner code
- Error handling and logging
- Modular database connection

## License

ISC