# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

## [0.3.0] - 2026-08-16

### Added

- Added independently configurable public Sessions and Projects endpoints backed by synchronized analytics.

### Security

- Public Sessions use a strict field allowlist, while public Projects expose only sanitized basename labels and bounded aggregate results.
- Sharing downgrades close both public analytics pages immediately, and PostgreSQL gates snapshot reads in the same queries that fetch them.

## [0.2.0] - 2026-08-16

### Added

- Added per-device private analytics storage, fleet aggregation, and a private device statistics endpoint.

### Changed

- Public snapshots are rebuilt from all current device snapshots after each synchronization.
