-- SHARKPOS 2 — 005: the demo loader reserves id ranges with setval(), which needs UPDATE on sequences.
GRANT UPDATE ON ALL SEQUENCES IN SCHEMA public TO sharkpos2_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON SEQUENCES TO sharkpos2_app;
