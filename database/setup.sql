-- =============================================
-- PostgreSQL Database Setup Script
-- Run this in pgAdmin 4's Query Tool
-- =============================================

-- STEP 1: Create the database
-- (You can also do this via pgAdmin GUI: right-click Databases → Create)
CREATE DATABASE github_auth_db;

-- STEP 2: Connect to the new database
-- In pgAdmin: click on github_auth_db in the left panel, then open Query Tool

-- STEP 3: Create the users table
-- NOTE: If synchronize=true in NestJS, this table is created AUTOMATICALLY.
-- This script is here so you can understand the structure and verify it in pgAdmin.
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,           -- Auto-incrementing ID: 1, 2, 3...
    github_id       VARCHAR(255) NOT NULL UNIQUE, -- GitHub's ID for this user (never changes)
    name            VARCHAR(255),                 -- Display name from GitHub profile
    email           VARCHAR(255),                 -- Email (may be empty if private)
    image           TEXT,                         -- Avatar URL (can be long)
    github_login    VARCHAR(255),                 -- GitHub username (e.g. "johndoe")
    last_login_at   TIMESTAMP,                    -- When they last signed in
    created_at      TIMESTAMP DEFAULT NOW(),      -- When account was first created
    updated_at      TIMESTAMP DEFAULT NOW()       -- When record was last changed
);

-- STEP 4: Create an index on github_id for fast lookups
-- Without this, searching by github_id scans the WHOLE table.
-- With this, PostgreSQL jumps directly to the right row.
CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);

-- STEP 5: (Optional) View your users after sign-ins
SELECT 
    id,
    github_id,
    name,
    email,
    github_login,
    last_login_at,
    created_at
FROM users
ORDER BY created_at DESC;

-- STEP 6: (Optional) Count total users
SELECT COUNT(*) as total_users FROM users;
