/**
 * app.js
 * 
 * Server file for the "What The Radio?" website.
 * 
 * Author: Scott Griffin
 * 
 * Index:
 * -------------------------------
 * Imports
 * Server variables
 * Tier details
 * Regular expressions
 * AWS configuration
 * Rate limiters
 * Helper functions
 * App setup
 * Route handlers
 * Start server
 * -------------------------------
 */

// -------------------------------
// Imports
// -------------------------------
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const bcrypt = require('bcrypt');
const path = require('path');
const nodemailer = require('nodemailer');
const leoProfanity = require('leo-profanity');
const multer = require('multer');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const uglifyJS = require('uglify-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mysql = require('mysql2/promise');
const AWS = require('aws-sdk');
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// -------------------------------
// Server variables
// -------------------------------

const systemEmail = process.env.SYSTEM_EMAIL;
const systemEmailPass = process.env.SYSTEM_EMAIL_PASS;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION;
const reservedStationNames = [
  'login',
  'signup',
  'confirm',
  'manage-tier',
  'account',
  'landing',
  'update-station',
  'check-station-name',
  'create-checkout-session',
  'payment-success',
  'update-tier',
  'logout',
  'demo',
  'whattheradio',
  'privacy',
  'terms',
  'contact',
  'faq',
  'about',
  'support',
  'discover',
  'search',
  'admin',
];

// Email transporter setup (for confirmation emails)
let transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: systemEmail,
    pass: systemEmailPass, // You need to enable "Less Secure Apps" or use an app password
  },
});

// -------------------------------
// Tier details
// -------------------------------

// Prices for each tier (in cents)
const tierPrices = {
  Silver: 300, // $3 per month
  Gold: 700, // $7 per month
};

// Limits for each tier
const tierListenerLimits = { // per month
  Free: Infinity,
  Silver: Infinity,
  Gold: Infinity
};

// Limits for station updates for each tier
const tierUpdateLimits = { // per day
  Free: 1,
  Silver: 5,
  Gold: 24
};

// Limits for station filesizes for each tier 
const tierFilesizeLimits = { // in kb
  Free: 50_000, // 50MB
  Silver: 600_000, // 600MB
  Gold: 3_000_000 // 3GB
};


// -------------------------------
// Regular expressions
// -------------------------------

// Define a regex for valid station names: only allow letters, numbers, and hyphens
const validNameRegex = /^[a-zA-Z0-9-]+$/;
// Regular expression for email validation
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Regular expression for password validation (allow special characters, but no spaces)
const passwordRegex = /^[\S]+$/;  // No spaces allowed, but any other character is permitted


// -------------------------------
// AWS configuration
// -------------------------------

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: REGION,
});
const s3 = new AWS.S3();

// Configure RDS MySQL connection
const db = mysql.createPool({
  host: process.env.DB_HOST,       // RDS endpoint
  user: process.env.DB_USER,       // MySQL username
  password: process.env.DB_PASS,   // MySQL password
  database: process.env.DB_NAME,   // Database name
  port: process.env.DB_PORT
});

// -------------------------------
// Rate limiters
// -------------------------------

// Short term general limiter to protect from quick abuse
const generalLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 1000, // Limit each IP to 1000 requests per day
  message: 'Too many requests from this IP today, please try again later.',
});
app.use(generalLimiter);

// Rate limiter for /discover
const discoverLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 requests per day
  message: 'Too many requests from this IP today, please try again later.',
});

// Rate limiter for radio station reaction buttons
const reactionLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 5, // Limit each IP to 5 requests per 10 seconds
  message: 'Too many requests from this IP today, please try again later.',
});

// Rate limiter for /login
const loginPageLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 requests per day
  message: 'Too many requests from this IP today, please try again later.',
});

// Rate limiter for /privacy
const privacyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 requests per day
  message: 'Too many requests from this IP today, please try again later.',
});

// Rate limiter for /terms
const termsLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 requests per day
  message: 'Too many requests from this IP today, please try again later.',
});

// Rate limiter for /login
const loginLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20, // Limit each IP to 20 login attempts per day
  message: 'Too many login attempts from this IP, please try again after 24 hours.',
});

// Rate limiter for /signup
const signupLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10, // Limit each IP to 10 signup attempts per day
  message: 'Too many signup attempts from this IP, please try again after 24 hours.',
});

// Rate limiter for /confirm/:email
const confirmEmailLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5, // Limit each IP to 5 confirm email attempts per day
  message: 'Too many confirm email attempts from this IP, please try again after 24 hours.',
});

// Rate limiter for landing/:email
const landingLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 10 landing page visits per day
  message: 'Too many landing page visits from this IP, please try again after 24 hours.',
});

// Rate limiter for /update-station
const updateStationLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 30, // Limit each IP to 30 update-station requests per day
  message: 'Too many update-station requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /account
const accountLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 account requests per day
  message: 'Too many account requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /manage-tier
const manageTierLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 manage-tier requests per day
  message: 'Too many manage-tier requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /create-checkout-session
const createCheckoutSessionLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 30, // Limit each IP to 30 create-checkout-session requests per day
  message: 'Too many create-checkout-session requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /payment-success
const paymentSuccessLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20, // Limit each IP to 20 payment-success requests per day
  message: 'Too many payment-success requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /update-tier
const updateTierLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 20, // Limit each IP to 20 update-tier requests per day
  message: 'Too many update-tier requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /logout
const logoutLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 30, // Limit each IP to 30 logout requests per day
  message: 'Too many logout requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /check-station-name
const checkStationNameLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 check-station-name requests per day
  message: 'Too many check-station-name requests from this IP, please try again after 24 hours.',
});

// Rate limiter for /:name
const nameLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 100, // Limit each IP to 100 requests per day
  message: 'Too many requests from this IP, please try again after 24 hours.',
});

// -------------------------------
// Helper functions
// -------------------------------

// Function to hash a password
async function hashPassword(password) {
  const saltRounds = 10; // The number of rounds to generate a salt (10 is a common default)
  try {
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    return hashedPassword;
  } catch (error) {
    console.error('Error hashing password:', error);
    throw error;
  }
}

// Function to verify a password
async function verifyPassword(plainPassword, hashedPassword) {
  try {
    const isMatch = await bcrypt.compare(plainPassword, hashedPassword);
    return isMatch;
  } catch (error) {
    console.error('Error verifying password:', error);
    throw error;
  }
}

// Authentication check function
function isAuthenticated(req, res, next) {
  if (req.session.email) {
    return next(); // User is authenticated, proceed to the next middleware
  } else {
    res.redirect('/'); // Redirect to login if not authenticated
  }
}

// Fetch users from the database
async function getUsers() {
  const [rows] = await db.query('SELECT * FROM users');
  return rows;
}

// Fetch a specific user by email
async function getUserByEmail(email) {
  const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0];
}

// Save a new user to the database
async function saveUser(user) {
  const { email, password, confirmed, tier, subscriptionEndDate, updates, disabled } = user;
  await db.query('INSERT INTO users (email, password, confirmed, tier, subscriptionEndDate, updates, disabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [email, password, confirmed, tier, subscriptionEndDate, updates, disabled]);
}

// Update user data in the database
async function updateUser(user) {
  const { email, password, confirmed, tier, subscriptionEndDate, updates, disabled } = user;
  await db.query('UPDATE users SET password = ?, confirmed = ?, tier = ?, subscriptionEndDate = ?, updates = ?, disabled = ? WHERE email = ?',
    [password, confirmed, tier, subscriptionEndDate, updates, disabled, email]);
}

// Fetch stations from the database
async function getStations() {
  const [rows] = await db.query('SELECT * FROM stations');
  return rows;
}

// Fetch a specific station by email
async function getStationByEmail(email) {
  const [rows] = await db.query('SELECT * FROM stations WHERE email = ?', [email]);
  return rows[0];
}

// Fetch a specific station by name
async function getStationByName(name) {
  const [rows] = await db.query('SELECT * FROM stations WHERE name = ?', [name]);
  return rows[0];
}

// Save or update station in the database
async function saveStation(station) {
  const { name, youtubeUrl, socialLink, radioMix, originalFilename, email, audioDuration, listenerCount } = station;

  await db.query(
    `INSERT INTO stations (name, youtubeUrl, socialLink, radioMix, originalFilename, email, audioDuration, listenerCount) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
    ON DUPLICATE KEY UPDATE 
    name = VALUES(name), 
    youtubeUrl = VALUES(youtubeUrl), 
    socialLink = VALUES(socialLink), 
    radioMix = VALUES(radioMix), 
    originalFilename = VALUES(originalFilename), 
    audioDuration = VALUES(audioDuration), 
    listenerCount = VALUES(listenerCount)`,
    [name, youtubeUrl, socialLink, radioMix, originalFilename, email, audioDuration, listenerCount]
  );
}


// Function to upload a file to S3
async function uploadFileToS3(file, bucketName, key) {
  const params = {
    Bucket: bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  try {
    const data = await s3.upload(params).promise();
    console.log(`File uploaded successfully at ${data.Location}`);
    return data.Location; // Return the URL of the uploaded file
  } catch (err) {
    console.error('Error uploading file to S3:', err);
    throw err;
  }
}

// Function to delete a file from S3
async function deleteFileFromS3(bucketName, fileUrl) {
  // Extract the key from the URL by removing the bucket's domain and decode it
  const key = decodeURIComponent(fileUrl.split(`${bucketName}.s3.${REGION}.amazonaws.com/`)[1]);

  if (!key) {
    console.error('Error: Could not extract the key from the file URL.');
    return;
  }

  const params = {
    Bucket: bucketName,
    Key: key,
  };

  try {
    const response = await s3.deleteObject(params).promise();
    console.log(`File deleted successfully: ${fileUrl}`);
    console.log('Delete response:', response);
  } catch (err) {
    console.error('Error deleting file from S3:', err);
    throw err;
  }
}

// -------------------------------
// App setup
// -------------------------------

// Multer setup to handle file uploads in memory
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Configure session middleware
app.use(session({
  secret: process.env.SESSION_SECRET, // Replace with a strong secret, keep it safe
  resave: false,           // Do not save session if unmodified
  saveUninitialized: false, // Do not create session until something is stored
  cookie: {
    secure: false,         // Set to true if using HTTPS in production
    maxAge: 1000 * 60 * 30 // Session expires after 30 minutes (in milliseconds)
  }
}));

// Middleware to uglify (minify and obfuscate) inline JavaScript
app.use((req, res, next) => {
  const originalRender = res.render;

  res.render = function (view, options = {}, callback) {
    originalRender.call(this, view, options, (err, html) => {
      if (err) {
        return callback ? callback(err, html) : next(err);
      }

      try {
        // Search for <script> tags and uglify their content
        const processedHtml = html.replace(/<script>([\s\S]*?)<\/script>/g, (match, jsContent) => {
          // Minify and mangle the inline JavaScript
          const uglifiedJs = uglifyJS.minify(jsContent, {
            compress: true,  // Enable compression
            mangle: true,    // Mangle variable names (obfuscation)
          });

          // If there's an error during uglification, log it and return the original content
          if (uglifiedJs.error) {
            console.error('UglifyJS error:', uglifiedJs.error);
            return match; // Return the original script block if there was an error
          }

          // Return the minified and obfuscated JavaScript within the <script> tag
          return `<script>${uglifiedJs.code}</script>`;
        });

        // Send the processed HTML response to the client
        callback ? callback(null, processedHtml) : res.send(processedHtml);
      } catch (minifyError) {
        next(minifyError);
      }
    });
  };

  next();
});

app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));


// -------------------------------
// Route handlers
// -------------------------------

// Discover Page (main landing)
app.get('/', discoverLimiter, async (req, res) => {
  console.log('GET / (discover page) triggered');
  try {
    // Fetch stations with both a radioMix and a youtubeUrl, ordered by likes in descending order
    const [stations] = await db.query('SELECT * FROM stations WHERE radioMix IS NOT NULL AND youtubeUrl IS NOT NULL ORDER BY likes DESC');

    // Render the discover page and pass the stations data along with session email
    res.render('discover', { stations, session: req.session });
  } catch (error) {
    console.error('Error fetching stations for discover page:', error);
    res.status(500).send('Failed to load discover page');
  }
});

// Route to handle updating reactions for a station
app.post('/station/:name/react', reactionLimiter, async (req, res) => {
  console.log('POST /station/:name/react triggered');
  const { name } = req.params;
  const { reactionType, increment } = req.body;

  if (!["likes", "flags"].includes(reactionType) || typeof increment !== "boolean") {
    return res.status(400).json({ message: "Invalid reaction or increment value" });
  }

  try {
    const incrementValue = increment ? 1 : -1;
    const reactionColumn = reactionType === "likes" ? "likes" : "flags";

    await db.query(
      `UPDATE stations SET ${reactionColumn} = GREATEST(0, ${reactionColumn} + ?) WHERE name = ?`,
      [incrementValue, name]
    );

    const [[updatedStation]] = await db.query(`SELECT likes, flags FROM stations WHERE name = ?`, [name]);
    res.json(updatedStation);
  } catch (error) {
    console.error("Error updating reaction count:", error);
    res.status(500).json({ message: "Failed to update reaction count" });
  }
});

// Login page
app.get('/login', loginPageLimiter, (req, res) => {
  console.log('GET /login triggered');
  res.render('login', {
    emailNotConfirmed: false,
    invalidLogin: false
  });
});

// Privacy Policy page
app.get('/privacy', privacyLimiter, (req, res) => {
  console.log('GET /privacy triggered');
  res.render('privacy');
});

// Terms of Use page
app.get('/terms', termsLimiter, (req, res) => {
  console.log('GET /terms triggered');
  res.render('terms');
});

// Handle login form submission
app.post('/login', loginLimiter, async (req, res) => {
  console.log('POST /login triggered');
  const { email, password } = req.body;

  // Check if the email is valid
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email' });
  }
  // Check if the password is valid (no spaces allowed)
  if (!password || !passwordRegex.test(password)) {
    return res.status(400).json({ message: 'Invalid password format. No spaces allowed.' });
  }

  // Check for existing user
  const user = await getUserByEmail(email);
  if (!user) {
    return res.status(400).json({ message: 'Invalid login credentials' });
  }

  // Verify password
  try {
    const isMatch = await verifyPassword(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid login credentials' });
    }
    // Check if the user is disabled
    if (user.disabled) {
      res.status(400).json({ message: 'Your account was disabled. Please email disagreeonline@gmail.com.' });
    } else if (user.confirmed) {
      req.session.email = user.email;  // Store email in session
      console.log('User logged in, email stored in session:', req.session.email);
      res.status(200).json({ message: 'Login successful', email: user.email });
    } else {
      res.status(400).json({ message: 'Please confirm your email before logging in.' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error during login' });
  }
});

// Handle sign-up form submission
app.post('/signup', signupLimiter, async (req, res) => {
  console.log('POST /signup triggered');
  const { email, password } = req.body;
  const existingUser = await getUserByEmail(email);

  // Check if the email is valid
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format' });
  }

  // Check if the password is valid (no spaces allowed)
  if (!password || !passwordRegex.test(password)) {
    return res.status(400).json({ message: 'Invalid password format. No spaces allowed.' });
  }

  // Check for existing user
  if (existingUser) {
    console.log('User already exists:', email);
    return res.status(400).json({ message: 'A user with that email already exists.' });
  }

  try {
    const hashedPassword = await hashPassword(password);
    await saveUser({
      email: email,
      password: hashedPassword,
      confirmed: false,
      tier: 'Free',
      subscriptionEndDate: null,
      updates: 0,
      disabled: false
    });

    // Send confirmation email
    const confirmationLink = `https://whattheradio.io/confirm/${email}`;
    console.log('Sending confirmation email to:', email);
    transporter.sendMail({
      from: systemEmail,
      to: email,
      subject: 'What The Radio? Confirm Your Email',
      text: `Click on the following link to confirm your email: ${confirmationLink}. It's coming from this email address because I ran out of gmail accounts I can make with my phone number :-).`,
    });

    res.status(200).json({ message: 'Signup successful. Please check your email for confirmation.' });
  } catch (error) {
    // Log the error details to the console
    console.error('Error during signup:', error);

    // Respond with a generic error message
    res.status(500).json({ message: 'Error during signup, please try again later.' });
  }
});

// Confirm email page
app.get('/confirm/:email', confirmEmailLimiter, async (req, res) => {
  console.log('GET /confirm triggered');
  console.log('Email to confirm:', req.params.email);
  // Validate the email from the URL parameters
  if (!emailRegex.test(req.params.email)) {
    return res.send('Invalid email format.');
  }

  // Get user email
  const user = await getUserByEmail(req.params.email);

  // Check if the user exists
  if (user) {
    user.confirmed = true;
    await updateUser(user);
    res.send('Email confirmed. You can now <a href="/">login</a>.');
  } else {
    res.send('Invalid confirmation link.');
  }
});

// Landing page for station editing
app.get('/landing/:email', landingLimiter, isAuthenticated, async (req, res) => {
  console.log('GET /landing triggered');
  console.log('Client email:', req.params.email);
  const email = req.params.email;

  // Validate the email from the URL parameters
  if (!emailRegex.test(email)) {
    return res.send('Invalid email format.');
  }

  // get user and station
  const station = await getStationByEmail(email);
  const user = await getUserByEmail(email);
  if (!user) {
    return res.status(404).send('User not found');
  }

  // Get users tier
  const userTier = user.tier;

  // Get the max filesize the user can upload
  const maxFilesizeKB = tierFilesizeLimits[userTier];

  // Get the max number of updates per day for a user
  const maxUpdates = tierUpdateLimits[userTier];

  // Check how many updates the user has left today
  var updatesLeft = maxUpdates - user.updates;
  var canUpdate = true;
  if (updatesLeft <= 0) {
    canUpdate = false;
    updatesLeft = 0
  };

  // Check if station is live
  let stationLive = false;
  if (station) {
    stationLive = true;
  }

  // Pass station details and user tier to the landing page
  res.render('landing', {
    station,
    stationLive,
    stationUpdated: false,
    stationNameTaken: false,
    userTier: user.tier,
    canUpdate,
    updatesLeft,
    maxFilesizeKB
  });
});

// Handle station update
app.post('/update-station', updateStationLimiter, isAuthenticated, upload.single('radioMix'), async (req, res) => {
  console.log('POST /update-station triggered');
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  try {
    // Fetch user from the database
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(404).send('User not found');
    }
    const userTier = user.tier;

    // Fetch the station from the database
    const station = await getStationByEmail(email);

    // if file is present
    if (req.file) {
      // Validate file size
      const radioMixFilesizeKB = req.file.size / 1000;
      // If uploaded filesize is over the limit for their tier
      if (radioMixFilesizeKB > tierFilesizeLimits[userTier]) {
        console.log('User tried to upload past their filesize limit, disabling their account');
        user.disabled = true;
        await updateUser(user);
        return res.redirect('/');
      }
      console.log('req.file:', req.file);
      console.log('req.file.originalname:', req.file.originalname);
      console.log('req.file.mimetype:', req.file.mimetype);

      // Validate file type
      const allowedMimeType = 'audio/mpeg';
      const allowedExtension = '.mp3';
      const fileExtension = path.extname(req.file.originalname).toLowerCase();
      if (req.file.mimetype !== allowedMimeType || fileExtension !== allowedExtension) {
        console.log('User tried to upload a non-MP3 file, disabling their account');
        user.disabled = true;
        await updateUser(user);
        return res.redirect('/');
      }
    }

    // Check if the user has reached the max number of updates per day
    const maxUpdates = tierUpdateLimits[userTier];
    const updatesLeft = maxUpdates - user.updates;
    if (updatesLeft <= 0) {
      console.log('User tried to update past their max update limit, disabling their account');
      user.disabled = true;
      await updateUser(user);
      return res.redirect('/');
    }

    // Initialize radio mix variables
    let radioMix = null;
    let originalFilename = null;
    let audioDuration = req.body.audioDuration;
    let listenerCount = 0; // Default listener count for a new station

    // Check if a new file is uploaded
    if (req.file) {
      console.log('Uploaded file:', req.file);

      // If the station exists and the original file name is the same, skip the upload
      if (station && station.originalFilename === req.file.originalname) {
        console.log('The same file was uploaded, no need to replace the existing file.');
        radioMix = station.radioMix;
        originalFilename = station.originalFilename;
      } else {

        // If the station exists and has an existing radio mix, delete it first
        if (station && station.radioMix) {
          console.log('Deleting old file:', station.radioMix);
          await deleteFileFromS3(S3_BUCKET_NAME, station.radioMix);
        }

        // A new file was uploaded, upload it to S3
        const fileKey = `${email}/${Date.now()}-${req.file.originalname}`;
        radioMix = await uploadFileToS3(req.file, S3_BUCKET_NAME, fileKey);
        originalFilename = req.file.originalname;
      }
    } else if (station) {
      // If no new file was uploaded, retain the old file details
      radioMix = station.radioMix;
      originalFilename = station.originalFilename;
      audioDuration = station.audioDuration;
      listenerCount = station.listenerCount;
    }

    // Construct new station data

    // Check the station name
    let badName = false;
    let name = req.body.name.trim();
    name = name.replace(/\s+/g, '-');
    name = name.toLowerCase();
    // Validate the name format: only alphanumeric characters and hyphens are allowed
    if (!validNameRegex.test(name)) {
      badName = true;
    }
    // Use leo-profanity to check if the name is profane
    if (leoProfanity.check(name)) {
      badName = true;
    }
    // Check if the name is reserved
    if (reservedStationNames.includes(name)) {
      badName = true;
    }
    // Check if station with that name already exists (but doesn't belong to them)
    const stationExists = await getStationByName(name);
    if (stationExists && stationExists.email !== email) {
      badName = true;
    }
    if (badName) { // if any of the name checks failed, disable the account
      console.log('User somehow submitted a bad name, disabling their account');
      user.disabled = true;
      await updateUser(user);
      return res.redirect('/');
    }

    const youtubeUrl = req.body.youtubeUrl;
    const socialLink = req.body.socialLink;

    const newStation = {
      name,
      youtubeUrl,
      socialLink,
      radioMix, // Retain old file if no new one, otherwise set the new file
      originalFilename, // Keep track of the original filename for future comparisons
      email,
      audioDuration,
      listenerCount
    };

    // If the station exists, update it, otherwise create a new one
    if (station) {
      console.log('Updating existing station:', newStation);
      await saveStation(newStation); // Update existing station
      user.updates += 1; // Increment the user's update count
      await updateUser(user);
    } else {
      console.log('Creating new station:', newStation);
      await saveStation(newStation); // Create new station
    }

    res.redirect(`/landing/${email}`);
  } catch (error) {
    console.error('Error during station update:', error);
    res.status(500).send('Failed to update station');
  }
});

// Account page
app.get('/account', accountLimiter, isAuthenticated, async (req, res) => {
  console.log('GET /account triggered');

  // Get the logged-in user's email from the session
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  const user = await getUserByEmail(email);

  if (user) {
    const userDataForView = {
      email: user.email,
      tier: user.tier,
      subscriptionEndDate: user.subscriptionEndDate,
    };
    res.render('account', { user: userDataForView });
  } else {
    res.status(404).send('Account not found');
  }
});

// Manage Subscription Tier page
app.get('/manage-tier', manageTierLimiter, isAuthenticated, async (req, res) => {
  console.log('GET /manage-tier triggered');
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  const user = await getUserByEmail(email);

  if (user) {
    // Send only the necessary data to the view
    const userDataForView = {
      tier: user.tier,
      subscriptionEndDate: user.subscriptionEndDate, // Only send if user is Silver or Gold
    };

    res.render('manage-tier', { user: userDataForView });
  } else {
    res.status(404).send('User not found');
  }
});

// Checkout session for stripe
app.post('/create-checkout-session', createCheckoutSessionLimiter, isAuthenticated, async (req, res) => {
  console.log('POST /create-checkout-session triggered');
  const { tier } = req.body;
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  // Only create a session if the user is upgrading to Silver or Gold
  if (tier === 'Free') {
    return res.redirect('/manage-tier'); // No payment required for Free tier
  }

  if (!tierPrices[tier]) {
    return res.status(400).send('Invalid tier selected');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email, // Use the user's email for the session
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `One Month of ${tier} Tier Access`,
            },
            unit_amount: tierPrices[tier], // The price in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.origin}/payment-success?session_id={CHECKOUT_SESSION_ID}&tier=${tier}`,
      cancel_url: `${req.headers.origin}/manage-tier`,
    });

    res.redirect(session.url);
  } catch (error) {
    console.log('Stripe error:', error);
    res.status(500).send('Failed to create Stripe session');
  }
});

// Payment success for stripe
app.get('/payment-success', paymentSuccessLimiter, async (req, res) => {
  console.log('GET /payment-success triggered');
  const { session_id, tier } = req.query;
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  if (!session_id || !tier) {
    return res.status(400).send('Invalid request');
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      const user = await getUserByEmail(email);

      if (user) {
        const now = new Date();
        let subscriptionEndDate = new Date(now);

        // If the user is staying on the same tier, extend the subscription.
        if (user.tier === tier && user.subscriptionEndDate && new Date(user.subscriptionEndDate) > now) {
          subscriptionEndDate = new Date(user.subscriptionEndDate);
          subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1); // Add 1 month to the current subscription
        } else {
          // If the user is switching tiers, reset the subscription end date to 1 month from now
          subscriptionEndDate.setMonth(subscriptionEndDate.getMonth() + 1); // Start a fresh 1-month subscription
        }

        // Update user's subscription tier and end date
        user.tier = tier;
        user.subscriptionEndDate = subscriptionEndDate;
        await updateUser(user);

        res.redirect('/manage-tier'); // Redirect back to the manage tier page after payment
      } else {
        res.status(404).send('User not found');
      }
    } else {
      res.status(400).send('Payment failed');
    }
  } catch (error) {
    console.log('Payment verification error:', error);
    res.status(500).send('Failed to verify payment');
  }
});

// Update user subscription tier
app.post('/update-tier', updateTierLimiter, isAuthenticated, async (req, res) => {
  console.log('POST /update-tier triggered');
  const email = req.session.email;
  const { tier } = req.body;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  // Validate the tier
  if (tier !== 'Free' && tier !== 'Silver' && tier !== 'Gold') {
    return res.status(400).json({ message: 'Invalid tier' });
  }

  if (tier === 'Free') {
    const user = await getUserByEmail(email);

    if (user) {
      user.tier = 'Free';
      user.subscriptionEndDate = null; // No end date for the Free tier
      await updateUser(user);
      res.redirect('/manage-tier');
    } else {
      res.status(404).send('User not found');
    }
  } else {
    // Redirect to Stripe checkout for paid tiers (Silver or Gold)
    res.redirect(`/create-checkout-session?tier=${tier}`);
  }
});

// Handle logout
app.get('/logout', logoutLimiter, async (req, res) => {
  console.log('GET /logout triggered');
  req.session.destroy((err) => {
    if (err) {
      console.log('Error destroying session:', err);
      return res.status(500).send('Failed to log out');
    }
    res.redirect('/'); // Redirect to login or home page after logging out
  });
});

// check if station name is taken
app.post('/check-station-name', checkStationNameLimiter, isAuthenticated, async (req, res) => {
  console.log('POST /check-station-name triggered');
  var name = req.body.name.trim();
  const email = req.session.email;

  // Validate the email from the session
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ message: 'Invalid email format or no email in session' });
  }

  name = name.replace(/\s+/g, '-');
  name = name.toLowerCase();

  // Validate the name format: only alphanumeric characters and hyphens are allowed
  if (!validNameRegex.test(name)) {
    return res.status(400).json({ available: false, error: 'Invalid name format. Only letters, numbers, and hyphens are allowed.' });
  }

  // Use leo-profanity to check if the name is profane
  if (leoProfanity.check(name)) {
    return res.status(400).json({ available: false, error: 'Station name contains inappropriate language. Please choose a different name.' });
  }

  // Check if the name is reserved
  if (reservedStationNames.includes(name)) {
    return res.status(200).json({ available: false, error: 'This station name is taken.' });
  }

  try {
    // Check if station exists and doesn't belong to them
    const stationExists = await getStationByName(name);
    if (stationExists && stationExists.email !== email) {
      return res.status(200).json({ available: false, error: 'This station name is already taken.' });
    }

    // Station name is available
    res.status(200).json({ available: true });
  } catch (error) {
    console.error('Error checking station name:', error);
    res.status(500).json({ error: 'Server error, please try again later.' });
  }
});

// Radio station page (THIS MUST BE LAST TO AVOID REQUEST HANDLING CONFLICTS)
app.get('/:name', nameLimiter, async (req, res) => {
  console.log('GET /:name triggered');
  // Validate the name from the URL parameters
  if (!req.params.name || !validNameRegex.test(req.params.name)) {
    return res.status(400).json({ message: 'Invalid station name format' });
  }

  const station = await getStationByName(req.params.name);

  // If station exists
  if (station) {
    const user = await getUserByEmail(station.email);
    const userTier = user ? user.tier : 'Free'; // Default to 'Free' if the user is not found

    // Increment listener count
    station.listenerCount += 1;
    await saveStation(station);

    // Replace the S3 URL with CloudFront URL for the radioMix
    if (station.radioMix) {
      const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
      // Modify the radioMix URL to use the CloudFront domain
      station.radioMix = station.radioMix.replace(/^https:\/\/[^/]+\.s3\.amazonaws\.com/, cloudFrontDomain);
    }
    console.log('station.radioMix:', station.radioMix);
    // Render the radio page
    res.render('radio', { station, userTier });
  } else {
    res.send('Station not found.');
  }
});


// -------------------------------
// Start server
// -------------------------------

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});