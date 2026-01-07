import apn from 'node-apn';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

interface APNsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKeyPath: string;
  production: boolean;
}

let apnProvider: apn.Provider | null = null;
let isInitialized = false;

export const initializeAPNs = async (): Promise<void> => {
  if (isInitialized) {
    logger.info('APNs already initialized');
    return;
  }

  try {
    const config: APNsConfig = {
      keyId: process.env.APNS_KEY_ID!,
      teamId: process.env.APNS_TEAM_ID!,
      bundleId: process.env.APNS_BUNDLE_ID!,
      privateKeyPath: process.env.APNS_PRIVATE_KEY_PATH!,
      production: process.env.APNS_PRODUCTION === 'true',
    };

    // Validate required configuration
    const requiredFields: (keyof APNsConfig)[] = [
      'keyId',
      'teamId',
      'bundleId',
      'privateKeyPath'
    ];

    for (const field of requiredFields) {
      if (!config[field]) {
        throw new Error(`Missing APNs configuration: ${field}`);
      }
    }

    // Check if private key file exists
    const keyPath = path.resolve(config.privateKeyPath);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`APNs private key file not found: ${keyPath}`);
    }

    // Read the private key
    const privateKey = fs.readFileSync(keyPath, 'utf8');

    // Initialize APNs provider
    const options: apn.ProviderOptions = {
      token: {
        key: privateKey,
        keyId: config.keyId,
        teamId: config.teamId,
      },
      production: config.production,
    };

    apnProvider = new apn.Provider(options);

    // Test connection (APNs doesn't provide a direct health check)
    logger.info('✅ APNs provider initialized successfully');
    logger.info(`🍎 Bundle ID: ${config.bundleId}`);
    logger.info(`🌍 Environment: ${config.production ? 'Production' : 'Development'}`);
    
    isInitialized = true;
    
  } catch (error) {
    logger.error('❌ Failed to initialize APNs:', error);
    throw error;
  }
};

export const getAPNsProvider = (): apn.Provider => {
  if (!apnProvider) {
    throw new Error('APNs provider not initialized');
  }
  return apnProvider;
};

export const closeAPNs = async (): Promise<void> => {
  if (apnProvider) {
    try {
      apnProvider.shutdown();
      apnProvider = null;
      isInitialized = false;
      logger.info('✅ APNs provider closed successfully');
    } catch (error) {
      logger.error('❌ Error closing APNs provider:', error);
      throw error;
    }
  }
};

export const isAPNsInitialized = (): boolean => isInitialized;

export const createAPNsNotification = (title: string, body: string, data?: any): apn.Notification => {
  const notification = new apn.Notification();
  
  notification.alert = {
    title,
    body,
  };
  
  notification.topic = process.env.APNS_BUNDLE_ID!;
  notification.sound = 'default';
  notification.badge = 1;
  
  if (data) {
    notification.payload = data;
  }
  
  // Expiry time (1 hour from now)
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  
  return notification;
};