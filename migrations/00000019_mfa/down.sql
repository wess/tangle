ALTER TABLE users
  DROP COLUMN totp_secret,
  DROP COLUMN totp_enabled,
  DROP COLUMN totp_backup_codes,
  DROP COLUMN totp_enabled_at;
