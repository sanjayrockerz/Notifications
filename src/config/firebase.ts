import admin from 'firebase-admin';
import { logger } from '../utils/logger';

interface FirebaseConfig {
  projectId: string;
  privateKeyId: string;
  privateKey: string;
  clientEmail: string;
  clientId: string;
  authUri: string;
  tokenUri: string;
}

let isInitialized = false;

export const initializeFirebase = async (): Promise<void> => {
  if (isInitialized) {
    logger.info('Firebase already initialized');
    return;
  }

  try {
    const config: FirebaseConfig = {
      projectId: process.env.FIREBASE_PROJECT_ID!,
      privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      clientId: process.env.FIREBASE_CLIENT_ID!,
      authUri: process.env.FIREBASE_AUTH_URI || 'https://accounts.google.com/o/oauth2/auth',
      tokenUri: process.env.FIREBASE_TOKEN_URI || 'https://oauth2.googleapis.com/token',
    };

    // Validate required configuration
    const requiredFields: (keyof FirebaseConfig)[] = [
      'projectId',
      'privateKeyId', 
      'privateKey',
      'clientEmail',
      'clientId'
    ];

    for (const field of requiredFields) {
      if (!config[field]) {
        throw new Error(`Missing Firebase configuration: ${field}`);
      }
    }

    // Initialize Firebase Admin SDK
    const serviceAccount = {
      type: 'service_account',
      project_id: config.projectId,
      private_key_id: config.privateKeyId,
      private_key: config.privateKey,
      client_email: config.clientEmail,
      client_id: config.clientId,
      auth_uri: config.authUri,
      token_uri: config.tokenUri,
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(config.clientEmail)}`,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
      projectId: config.projectId,
    });

    // Test the connection by getting a token
    const messaging = admin.messaging();
    
    isInitialized = true;
    logger.info('✅ Firebase initialized successfully');
    logger.info(`📦 Project ID: ${config.projectId}`);
    
  } catch (error) {
    logger.error('❌ Failed to initialize Firebase:', error);
    throw error;
  }
};

export const getFirebaseApp = (): admin.app.App => {
  if (!isInitialized) {
    throw new Error('Firebase not initialized');
  }
  return admin.app();
};

export const getMessaging = (): admin.messaging.Messaging => {
  if (!isInitialized) {
    throw new Error('Firebase not initialized');
  }
  return admin.messaging();
};

export const isFirebaseInitialized = (): boolean => isInitialized;