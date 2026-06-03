const roleRank = {
    OWNER: 3,
    ADMIN: 2,
    MEMBER: 1,
    VIEWER: 0
};
export function hasRole(role, required) {
    return roleRank[role] >= roleRank[required];
}
