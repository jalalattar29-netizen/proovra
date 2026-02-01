# Digital Witness – Official Project Context

## Goal
Build a production-grade, company-level Digital Witness platform.

## Product
A mobile app + web platform that allows users to:
- Capture video/audio evidence
- Attach GPS + UTC metadata
- Hash files with SHA-256
- Upload to S3-compatible storage
- Generate cryptographic fingerprints
- Sign fingerprints server-side (Ed25519)
- Maintain an append-only chain of custody
- Generate verifiable PDF evidence reports
- Verify evidence publicly via web

## Quality Bar
- No prototypes
- No shortcuts
- Production-ready architecture
- Scalable from day one

## Tech Stack
- Monorepo
- Fastify API (TypeScript)
- Prisma + PostgreSQL
- Redis + BullMQ
- Cloudflare R2 (prod) / MinIO (local)
- Next.js Web (Verify + Landing)
- Flutter Mobile App

## Constraints
- Treat this as a startup product
- Architecture must not require rewriting later
