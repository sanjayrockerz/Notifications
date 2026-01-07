import UserPreferences from '../models/UserPreferences';
import { logger } from './logger';

/**
 * Parse time string (HH:MM) and convert to minutes since midnight
 */
function parseTime(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  if (hours === undefined || minutes === undefined) {
    throw new Error(`Invalid time format: ${timeStr}`);
  }
  return hours * 60 + minutes;
}

/**
 * Check if current time is within quiet hours for user's timezone
 * @param userId - User ID to check quiet hours for
 * @param currentTime - Optional current time (for testing), defaults to now
 * @returns Object with isQuietHours boolean and nextAvailableTime if in quiet hours
 */
export async function checkQuietHours(
  userId: string,
  currentTime?: Date
): Promise<{
  isQuietHours: boolean;
  nextAvailableTime?: Date;
  quietHoursConfig?: {
    enabled: boolean;
    start: string;
    end: string;
    timezone: string;
  };
}> {
  try {
    const preferences = await UserPreferences.findOne({ userId });

    if (!preferences || !preferences.quietHours || !preferences.quietHours.enabled) {
      // No quiet hours configured or disabled
      return { isQuietHours: false };
    }

    const { start, end, timezone } = preferences.quietHours;
    const now = currentTime || new Date();

    // Convert current time to user's timezone
    const userTimeStr = now.toLocaleTimeString('en-US', {
      timeZone: timezone || 'UTC',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    const currentMinutes = parseTime(userTimeStr);
    const startMinutes = parseTime(start);
    const endMinutes = parseTime(end);

    let isInQuietHours = false;

    // Check if quiet hours span midnight (e.g., 22:00 - 09:00)
    if (startMinutes > endMinutes) {
      // Spans midnight: quiet from start to midnight, and midnight to end
      isInQuietHours = currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } else {
      // Same day: quiet from start to end
      isInQuietHours = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }

    if (!isInQuietHours) {
      return {
        isQuietHours: false,
        quietHoursConfig: preferences.quietHours,
      };
    }

    // Calculate next available time (end of quiet hours)
    const nextAvailableTime = calculateNextAvailableTime(now, end, timezone || 'UTC', startMinutes, endMinutes, currentMinutes);

    logger.info(`⏰ User ${userId} in quiet hours (${start} - ${end} ${timezone}), next available: ${nextAvailableTime.toISOString()}`);

    return {
      isQuietHours: true,
      nextAvailableTime,
      quietHoursConfig: preferences.quietHours,
    };
  } catch (error) {
    logger.error('Error checking quiet hours:', error);
    // Default to not in quiet hours on error
    return { isQuietHours: false };
  }
}

/**
 * Calculate the next available time after quiet hours end
 */
function calculateNextAvailableTime(
  currentTime: Date,
  endTime: string,
  timezone: string,
  startMinutes: number,
  endMinutesParam: number,
  currentMinutes: number
): Date {
  const [endHours, endMinutes] = endTime.split(':').map(Number);
  
  // Get current date in user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(currentTime);
  const year = parseInt(parts.find(p => p.type === 'year')!.value);
  const month = parseInt(parts.find(p => p.type === 'month')!.value) - 1; // JS months are 0-indexed
  const day = parseInt(parts.find(p => p.type === 'day')!.value);

  // Create date for end of quiet hours
  let nextAvailable = new Date(Date.UTC(year, month, day, endHours, endMinutes, 0, 0));

  // If quiet hours span midnight and we're after midnight but before end
  if (startMinutes > endMinutesParam && currentMinutes < endMinutesParam) {
    // End time is today
  } else if (startMinutes > endMinutesParam) {
    // End time is tomorrow
    nextAvailable.setUTCDate(nextAvailable.getUTCDate() + 1);
  } else if (currentMinutes >= endMinutesParam) {
    // Missed today's end time, next available is tomorrow
    nextAvailable.setUTCDate(nextAvailable.getUTCDate() + 1);
  }

  // Convert UTC back to local time
  // Adjust for timezone offset
  const timezoneOffset = getTimezoneOffset(timezone, nextAvailable);
  nextAvailable = new Date(nextAvailable.getTime() - timezoneOffset);

  return nextAvailable;
}

/**
 * Get timezone offset in milliseconds
 */
function getTimezoneOffset(timezone: string, date: Date): number {
  try {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return utcDate.getTime() - tzDate.getTime();
  } catch (error) {
    logger.error('Error calculating timezone offset:', error);
    return 0;
  }
}

/**
 * Check if notification should be delivered immediately despite quiet hours
 * Urgent notifications (mentions, messages) bypass quiet hours
 */
export function isUrgentNotification(category: string, priority: string, urgent?: boolean): boolean {
  // Explicit urgent flag
  if (urgent === true) {
    return true;
  }

  // High priority and critical categories
  if (priority === 'critical' || priority === 'high') {
    return true;
  }

  // Urgent categories
  const urgentCategories = ['mention', 'message', 'alert', 'security'];
  if (urgentCategories.includes(category.toLowerCase())) {
    return true;
  }

  return false;
}
