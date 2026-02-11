/**
 * Advanced Search Routes
 * Full-text search, filtering, and pagination for evidence
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db.js";
import { AppError, ErrorCode } from "../errors.js";

export async function searchRoutes(app: FastifyInstance) {
  /**
   * Search evidence
   * GET /v1/search/evidence?q=query&type=PHOTO&page=1&limit=20
   */
  app.get(
    "/v1/search/evidence",
    { preHandler: [requireAuth] },
    async (req: any, res: any) => {
      try {
        const querySchema = z.object({
          q: z.string().min(1).max(200).optional(),
          type: z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]).optional(),
          status: z.enum(["PENDING", "SIGNED", "ARCHIVED"]).optional(),
          fromDate: z.string().datetime().optional(),
          toDate: z.string().datetime().optional(),
          caseId: z.string().uuid().optional(),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(100).default(20),
          sortBy: z.enum(["createdAt", "updatedAt", "type"]).default("createdAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        });

        const query = querySchema.parse(req.query);
        const userId = req.user!.sub;

        // Build where clause
        const where: any = {
          ownerUserId: userId,
          deletedAt: null,
        };

        if (query.type) {
          where.type = query.type;
        }

        if (query.status) {
          where.status = query.status;
        }

        if (query.caseId) {
          where.caseId = query.caseId;
        }

        if (query.fromDate || query.toDate) {
          where.createdAt = {};
          if (query.fromDate) {
            where.createdAt.gte = new Date(query.fromDate);
          }
          if (query.toDate) {
            where.createdAt.lte = new Date(query.toDate);
          }
        }

        // Full-text search if query provided
        if (query.q) {
          where.OR = [
            {
              id: {
                contains: query.q,
                mode: "insensitive",
              },
            },
            {
              mimeType: {
                contains: query.q,
                mode: "insensitive",
              },
            },
          ];
        }

        // Get total count
        const total = await prisma.evidence.count({ where });

        // Get paginated results
        const skip = (query.page - 1) * query.limit;
        const evidence = await prisma.evidence.findMany({
          where,
          select: {
            id: true,
            type: true,
            status: true,
            mimeType: true,
            createdAt: true,
            updatedAt: true,
            caseId: true,
          },
          orderBy: {
            [query.sortBy]: query.sortOrder,
          },
          skip,
          take: query.limit,
        });

        return {
          data: evidence,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid search parameters",
            { fields: error.flatten() }
          );
        }
        throw error;
      }
    }
  );

  /**
   * Search cases
   * GET /v1/search/cases?q=query&page=1&limit=20
   */
  app.get(
    "/v1/search/cases",
    { preHandler: [requireAuth] },
    async (req: any) => {
      try {
        const querySchema = z.object({
          q: z.string().min(1).max(200).optional(),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(100).default(20),
          sortBy: z.enum(["createdAt", "name"]).default("createdAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
        });

        const query = querySchema.parse(req.query);
        const userId = req.user!.sub;

        // Build where clause
        const where: any = {
          ownerUserId: userId,
        };

        // Full-text search
        if (query.q) {
          where.OR = [
            {
              name: {
                contains: query.q,
                mode: "insensitive",
              },
            },
          ];
        }

        // Get total count
        const total = await prisma.case.count({ where });

        // Get paginated results
        const skip = (query.page - 1) * query.limit;
        const cases = await prisma.case.findMany({
          where,
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: {
            [query.sortBy]: query.sortOrder,
          },
          skip,
          take: query.limit,
        });

        return {
          data: cases,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: Math.ceil(total / query.limit),
          },
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Invalid search parameters",
            { fields: error.flatten() }
          );
        }
        throw error;
      }
    }
  );

  /**
   * Get search suggestions/autocomplete
   * GET /v1/search/suggest?q=query
   */
  app.get(
    "/v1/search/suggest",
    { preHandler: [requireAuth] },
    async (req: any) => {
      try {
        const q = req.query.q as string;
        if (!q || q.length < 2) {
          return { suggestions: [] };
        }

        const userId = req.user!.sub;
        const searchTerm = q.toLowerCase();

        const suggestions: Array<{
          type: string;
          id: string;
          title: string;
        }> = [];

        // Evidence suggestions
        const evidence = await prisma.evidence.findMany({
          where: {
            ownerUserId: userId,
            deletedAt: null,
            mimeType: { contains: searchTerm, mode: "insensitive" },
          },
          select: { id: true, type: true, createdAt: true },
          take: 3,
        });

        suggestions.push(
          ...evidence.map((e: { id: string; type: string; createdAt: Date }) => ({
            type: "evidence",
            id: e.id,
            title: `${e.type} - ${new Date(e.createdAt).toLocaleDateString()}`,
          }))
        );

        // Case suggestions
        const cases = await prisma.case.findMany({
          where: {
            ownerUserId: userId,
            name: { contains: searchTerm, mode: "insensitive" },
          },
          select: { id: true, name: true },
          take: 3,
        });

        suggestions.push(
          ...cases.map((c: { id: string; name: string }) => ({
            type: "case",
            id: c.id,
            title: c.name,
          }))
        );

        return { suggestions };
      } catch (error) {
        req.log.error({ error }, "Search suggest failed");
        return { suggestions: [] };
      }
    }
  );
}
