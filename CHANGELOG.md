# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased]

## [0.4.0] - 2026-10-02

### Added

- Add independent profile audiences with friend email and auth-service group allowlists, enforcing access across shared dashboards, Sessions and Projects.

### Security

- Check current group membership on each group-based read, fail closed when auth groups are unavailable, keep recipient lists private, and exclude selected profiles from public rankings.

## [0.3.4] - 2026-09-27

### Fixed

- Support explicit device aliases so a reinstalled computer appears once without discarding older sessions or double-counting overlaps.

## [0.3.3] - 2026-09-27

### Fixed

- Use updated core pricing and corrected Codex token counts for locally collected analytics.

## [0.3.2] - 2026-09-27

### Fixed

- Use corrected core model attribution in hosted analytics instead of showing unidentified models as GLM 5.2.

## [0.3.1] - 2026-09-26

### Changed

- Renamed the workspace package and core import to `@harness-analyzer`.
- Identified model pricing requests as Harness Analyzer.

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
