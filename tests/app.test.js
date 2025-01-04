/**
 * app.tests.js
 * 
 * This test suite validates core application features, including:
 * 
 * 1. Database Operations:
 *    - Insert a test user and station into the database.
 * 
 * 2. AWS S3 Integration:
 *    - Upload and delete a test .mp3 file in S3.
 * 
 * 3. Email Functionality:
 *    - Send a confirmation email using `nodemailer`.
 * 
 * 4. Cleanup:
 *    - Remove test data from the database and S3 after tests.
 * 
 * Prerequisites:
 * - Set required environment variables (AWS, MySQL, Email).
 * - Include `test-audio.mp3` in the test directory.
 * 
 * Note: Uses live AWS and database environments. 
 * 
 * Author: Scott Griffin
 */

// Import required modules
const request = require('supertest'); // To make HTTP requests to the app during tests
const path = require('path'); // For resolving file paths
const nodemailer = require('nodemailer'); // For sending confirmation emails
const AWS = require('aws-sdk'); // For interacting with AWS S3
const mysql = require('mysql2/promise'); // For asynchronous MySQL operations
const bcrypt = require('bcrypt'); // For hashing passwords
const fs = require('fs'); // For file operations

// AWS S3 Configuration
// S3 client setup for uploading and deleting files during tests
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, // AWS Access Key ID from environment variables
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, // AWS Secret Access Key from environment variables
  region: process.env.AWS_REGION, // AWS region where the S3 bucket is hosted
});

// Database Connection Pool
let db; // Global variable for the database connection pool

/**
 * Establish a database connection pool before running the tests.
 */
beforeAll(async () => {
  db = await mysql.createPool({
    host: process.env.DB_HOST, // Database host
    user: process.env.DB_USER, // Database user
    password: process.env.DB_PASS, // Database password
    database: process.env.DB_NAME, // Database name
    port: process.env.DB_PORT, // Database port
  });
});

/**
 * Close the database connection pool after running the tests.
 */
afterAll(async () => {
  if (db) {
    await db.end(); // Gracefully close the database connection pool
  }
});

// Test Suite: Production Tests
describe('Production Tests', () => {
  // Test data setup
  const testUserEmail = 'testuser@example.com';
  const testUserPassword = 'testpassword';
  const testStationName = 'test-station';
  const testMp3Path = path.join(__dirname, 'test-audio.mp3'); // Path to the test .mp3 file
  let testUserId; // Will hold the test user's ID after insertion

  /**
   * Test: Insert a test user into the database.
   * This verifies user creation functionality.
   */
  test('Create a test user in the database', async () => {
    const hashedPassword = await bcrypt.hash(testUserPassword, 10); // Hash the password for secure storage
    const [result] = await db.query(
      'INSERT INTO users (email, password, confirmed, tier, updates, disabled) VALUES (?, ?, ?, ?, ?, ?)',
      [testUserEmail, hashedPassword, false, 'Free', 0, false]
    );
    expect(result.affectedRows).toBe(1); // Ensure one row was inserted
    testUserId = result.insertId; // Save the inserted user ID for later use
  });

  /**
   * Test: Create a test radio station and upload a test .mp3 file to S3.
   * This verifies station creation and file upload functionality.
   */
  test('Create a test radio station and upload a test .mp3', async () => {
    const fileStream = fs.createReadStream(testMp3Path); // Stream the test audio file

    // Parameters for S3 upload
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME, // Target S3 bucket
      Key: `${testUserEmail}/test-audio.mp3`, // Key for the uploaded file
      Body: fileStream,
      ContentType: 'audio/mpeg',
    };

    // Upload the file to S3
    const s3Response = await s3.upload(uploadParams).promise();
    expect(s3Response.Location).toBeDefined(); // Ensure the upload was successful

    fileStream.destroy(); // Explicitly close the file stream to release resources

    // Insert the station into the database
    const [result] = await db.query(
      'INSERT INTO stations (name, email, radioMix, originalFilename) VALUES (?, ?, ?, ?)',
      [testStationName, testUserEmail, s3Response.Location, 'test-audio.mp3']
    );
    expect(result.affectedRows).toBe(1); // Ensure one row was inserted
  });

  /**
   * Test: Send a confirmation email to the test user.
   * This verifies the email-sending functionality.
   */
  test('Send a confirmation email to the test user', async () => {
    const transporter = nodemailer.createTransport({
      service: 'gmail', // Email service
      auth: {
        user: process.env.SYSTEM_EMAIL, // System email address
        pass: process.env.SYSTEM_EMAIL_PASS, // System email password
      },
    });

    // Email content
    const confirmationLink = `https://your-production-domain.com/confirm/${testUserEmail}`;
    const mailOptions = {
      from: process.env.SYSTEM_EMAIL, // Sender email address
      to: testUserEmail, // Recipient email address
      subject: 'Confirm Your Email',
      text: `Please confirm your email by clicking the following link: ${confirmationLink}`,
    };

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    expect(info.accepted).toContain(testUserEmail); // Ensure the email was sent successfully
  });

  /**
   * Cleanup: Remove test data and files after tests.
   * - Deletes the test user and station from the database.
   * - Deletes the test file from S3.
   */
  afterAll(async () => {
    // Delete the test user from the database
    await db.query('DELETE FROM users WHERE email = ?', [testUserEmail]);

    // Delete the test station from the database
    await db.query('DELETE FROM stations WHERE name = ?', [testStationName]);

    // Delete the test file from S3
    await s3
      .deleteObject({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `${testUserEmail}/test-audio.mp3`,
      })
      .promise();
  });
});