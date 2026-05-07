export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  permissions: string[];
}

export const PERMISSIONS = {
  READ_RESOURCES: 'read:resources',
  WRITE_RESOURCES: 'write:resources',
  DELETE_RESOURCES: 'delete:resources',
  BULK_IMPORT: 'bulk:import'
} as const;

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    PERMISSIONS.READ_RESOURCES,
    PERMISSIONS.WRITE_RESOURCES,
    PERMISSIONS.DELETE_RESOURCES,
    PERMISSIONS.BULK_IMPORT
  ],
  operator: [
    PERMISSIONS.READ_RESOURCES,
    PERMISSIONS.WRITE_RESOURCES,
    PERMISSIONS.BULK_IMPORT
  ],
  viewer: [
    PERMISSIONS.READ_RESOURCES
  ]
};

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission) || ROLE_PERMISSIONS[user.role].includes(permission);
}

export function getUserFromEvent(event: any): User {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) {
    throw new Error('No authorization header');
  }
  
  // Simple JWT decode simulation - in real implementation, verify JWT
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || 'unknown',
      role: payload.role || 'viewer',
      permissions: payload.permissions || []
    };
  } catch (error) {
    throw new Error('Invalid token');
  }
}

export function requirePermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}