import mongoose from 'mongoose';
import { logger } from '../utils/logger';

interface DatabaseConfig {
  uri: string;
  options: mongoose.ConnectOptions;
}

const config: DatabaseConfig = {
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/notifications',
  options: {
    maxPoolSize: 10,
    minPoolSize: 5,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4,
  },
};

let isConnected = false;

export const connectDatabase = async (): Promise<void> => {
  if (isConnected) {
    logger.info('Database already connected');
    return;
  }

  try {
    mongoose.set('strictQuery', true);
    
    await mongoose.connect(config.uri, config.options);
    
    isConnected = true;
    logger.info('✅ MongoDB connected successfully');
    
    // Connection event handlers
    mongoose.connection.on('error', (error) => {
      logger.error('❌ MongoDB connection error:', error);
    });
    
    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
      isConnected = false;
    });
    
    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected');
      isConnected = true;
    });
    
  } catch (error) {
    logger.error('❌ Failed to connect to MongoDB:', error);
    throw error;
  }
};

export const disconnectDatabase = async (): Promise<void> => {
  if (!isConnected) {
    return;
  }
  
  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('✅ MongoDB disconnected successfully');
  } catch (error) {
    logger.error('❌ Error disconnecting from MongoDB:', error);
    throw error;
  }
};

export const getDatabaseConnection = () => mongoose.connection;
export const isDbConnected = () => isConnected;