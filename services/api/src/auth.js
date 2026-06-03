export function getAuthUserId(req) {
    if (!req.user?.sub) {
        throw new Error("Unauthenticated");
    }
    return req.user.sub;
}
