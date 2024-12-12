const request = require('supertest'); // For making HTTP requests to the app
const path = require('path'); // For file path handling
const nodemailer = require('nodemailer'); // For email sending confirmation
const AWS = require('aws-sdk'); // For S3 interactions
const mysql = require('mysql2/promise'); // For MySQL database interactions
const bcrypt = require('bcrypt'); // For password hashing
const fs = require('fs'); // For file handling

// Setup AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Setup database connection
let db;
beforeAll(async () => {
  db = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
  });
});

afterAll(async () => {
  if (db) {
    await db.end(); // Ensure the database connection is closed
  }
});

describe('Production Tests', () => {
  const testUserEmail = 'testuser@example.com';
  const testUserPassword = 'testpassword';
  const testStationName = 'test-station';
  const testMp3Path = path.join(__dirname, 'test-audio.mp3'); // Replace with the path to your test .mp3 file
  let testUserId;

  test('Create a test user in the database', async () => {
    const hashedPassword = await bcrypt.hash(testUserPassword, 10);
    const [result] = await db.query(
      'INSERT INTO users (email, password, confirmed, tier, updates, disabled) VALUES (?, ?, ?, ?, ?, ?)',
      [testUserEmail, hashedPassword, false, 'Free', 0, false]
    );
    expect(result.affectedRows).toBe(1);
    testUserId = result.insertId; // Save the test user ID for later use
  });

  test('Create a test radio station and upload a test .mp3', async () => {
    const fileStream = fs.createReadStream(testMp3Path);

    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `${testUserEmail}/test-audio.mp3`,
      Body: fileStream,
      ContentType: 'audio/mpeg',
    };

    const s3Response = await s3.upload(uploadParams).promise();
    expect(s3Response.Location).toBeDefined();

    fileStream.destroy(); // Explicitly close the file stream

    const [result] = await db.query(
      'INSERT INTO stations (name, email, radioMix, originalFilename) VALUES (?, ?, ?, ?)',
      [testStationName, testUserEmail, s3Response.Location, 'test-audio.mp3']
    );
    expect(result.affectedRows).toBe(1);
  });

  test('Send a confirmation email to the test user', async () => {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SYSTEM_EMAIL,
        pass: process.env.SYSTEM_EMAIL_PASS,
      },
    });

    const confirmationLink = `https://your-production-domain.com/confirm/${testUserEmail}`;
    const mailOptions = {
      from: process.env.SYSTEM_EMAIL,
      to: testUserEmail,
      subject: 'Confirm Your Email',
      text: `Please confirm your email by clicking the following link: ${confirmationLink}`,
    };

    const info = await transporter.sendMail(mailOptions);
    expect(info.accepted).toContain(testUserEmail);
  });

  afterAll(async () => {
    // Cleanup: Delete the test user and station from the database
    await db.query('DELETE FROM users WHERE email = ?', [testUserEmail]);
    await db.query('DELETE FROM stations WHERE name = ?', [testStationName]);

    // Cleanup: Delete the test file from S3
    await s3
      .deleteObject({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: `${testUserEmail}/test-audio.mp3`,
      })
      .promise();
  });
});