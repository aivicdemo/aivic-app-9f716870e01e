import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, requirePermission, PERMISSIONS, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayProxyEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string } | null;
  queryStringParameters?: { [key: string]: string } | null;
  body?: string | null;
  headers: { [key: string]: string };
}

interface APIGatewayProxyResult {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

function createResponse(statusCode: number, body: any, headers: { [key: string]: string } = {}): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...headers
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(user: User, action: string, resourceId?: string, details?: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resourceId,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

async function handleGetResources(event: APIGatewayProxyEvent, user: User): Promise<APIGatewayProxyResult> {
  try {
    requirePermission(user, PERMISSIONS.READ_RESOURCES);
    
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden', message: error.message });
    }
    return createResponse(500, { error: 'Internal Server Error', message: error.message });
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, user: User): Promise<APIGatewayProxyResult> {
  try {
    requirePermission(user, PERMISSIONS.BULK_IMPORT);
    
    if (!event.body) {
      return createResponse(400, { error: 'Bad Request', message: 'Request body is required' });
    }
    
    const { items } = JSON.parse(event.body);
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Bad Request', message: 'Items must be an array' });
    }
    
    const now = new Date().toISOString();
    const processedItems = items.map(item => ({
      ...item,
      id: item.id || randomUUID(),
      createdAt: now,
      updatedAt: now
    }));
    
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < processedItems.length; i += 25) {
      const batch = processedItems.slice(i, i + 25);
      
      try {
        const writeRequests = batch.map(item => ({
          PutRequest: {
            Item: item
          }
        }));
        
        await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        }));
        
        imported += batch.length;
      } catch (error: any) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error.message}`);
      }
    }
    
    // Create audit log
    await createAuditLog(user, 'BULK_IMPORT', undefined, {
      totalItems: items.length,
      imported,
      failed
    });
    
    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden', message: error.message });
    }
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Bad Request', message: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal Server Error', message: error.message });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  try {
    const user = getUserFromEvent(event);
    
    // Route handling
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event, user);
    }
    
    // Bulk import endpoint pattern: POST /api/{tableIndex}/bulk
    const bulkImportMatch = path.match(/^\/api\/\d+\/bulk$/);
    if (method === 'POST' && bulkImportMatch) {
      return await handleBulkImport(event, user);
    }
    
    return createResponse(404, { error: 'Not Found', message: 'Endpoint not found' });
    
  } catch (error: any) {
    if (error.message.includes('authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized', message: 'Invalid or missing authentication' });
    }
    return createResponse(500, { error: 'Internal Server Error', message: error.message });
  }
};