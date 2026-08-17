# Real-Time Analytics System

This document describes the new real-time analytics system for tracking unique ISCC codes and declarer statistics.

## Overview

The analytics system provides fast, efficient access to analytics data through a combination of:
1. **Real-time counters** - Updated during declaration processing
2. **Periodic recalculation** - 48-hour cron job for accuracy verification
3. **Fallback mechanisms** - Force recalculation when needed

## Architecture

### Components

1. **AnalyticsCounters DynamoDB Table**
   - Stores real-time counters and metadata
   - Primary key: `counterKey`
   - Fields: `counterValue`, `lastUpdated`, `metadata`

2. **Analytics Utility Functions** (`analyticsUtil.ts`)
   - Counter management functions
   - Real-time update handlers
   - Data retrieval functions

3. **Declaration Processor Integration**
   - Updates counters during ISCC processing
   - Non-blocking to avoid disrupting main flow

4. **Cron Job** (`analyticsRecalculation.ts`)
   - Runs every 48 hours
   - Performs full S3 calculation
   - Updates cached data
   - Reports data drift

5. **Enhanced API Endpoint** (`getUniqueIsccAmount.ts`)
   - Returns cached data by default (fast)
   - Triggers a background recalculation when the cached data is stale
   - Includes data source information

## Counter Keys

- `total_unique_iscc` - Total number of unique ISCC codes
- `declarer_stats` - Number of declarers (with full stats in metadata)
- `last_full_calculation` - Timestamp of last complete recalculation
- `declarer_{declarerId}_unique_iscc` - Per-declarer unique ISCC counts

## API Usage

### Fast Analytics (Default)
```bash
GET /api/v1/uniqueIsccCount
```

Returns cached data with sub-second response time.

### Background Recalculation
The system automatically triggers background recalculation when data becomes stale (older than 2 hours). This ensures the API always responds immediately while keeping data fresh.

### Manual Recalculation
```bash
POST /api/v1/recalculateAnalytics
```

Triggers immediate recalculation (requires API key).

### System Setup
```bash
POST /api/v1/setupAnalytics
```

Initializes the analytics system with initial data calculation.

### System Status
```bash
GET /api/v1/analyticsStatus
```

Returns health status and system information.

## Response Format

```json
{
  "unique_iscc": {
    "declarerStats": [
      {
        "declarerId": "did:key:example",
        "uniqueIsccCount": 123,
        "totalDeclarations": 456
      }
    ],
    "totalUniqueIscc": 789,
    "totalDeclarations": 1234
  },
  "data_source": "calculated|realtime",
  "last_updated": 1703123456789,
  "last_updated_iso": "2023-12-21T10:30:56.789Z",
  "is_stale": false,
  "background_refresh_triggered": false,
  "version": "1.0.0"
}
```

## Performance Improvements

### Before
- **Response Time**: 10-60 seconds
- **Resource Usage**: High (S3 scanning)
- **Scalability**: Poor (grows with data size)
- **Availability**: Blocks during calculation

### After
- **Response Time**: <200ms (always from cache)
- **Resource Usage**: Minimal (DynamoDB read)
- **Scalability**: Excellent (constant time)
- **Availability**: 100% (never blocks)

## Data Accuracy

- **Real-time Updates**: Approximate counts during high-volume periods
- **48-Hour Recalculation**: The cron reconciles drift every 48 hours
- **Drift Monitoring**: Automatic reporting of counter drift
- **Manual Recalculation**: On-demand accurate counts via `POST /api/v1/recalculateAnalytics`

## Monitoring

The system automatically sends Slack notifications for:
- Successful recalculations
- Recalculation errors
- Data drift percentages
- Performance metrics

## Deployment

The analytics system is automatically deployed as part of the CommonsDB stack:

1. DynamoDB table creation
2. Lambda function bindings
3. Cron job scheduling
4. API endpoint configuration

### Post-Deployment Setup

After deploying the stack, initialize the system:

```typescript
// Call the setup endpoint to initialize analytics
const response = await fetch(`${API_URL}/api/v1/setupAnalytics`, {
  method: 'POST',
  headers: {
    'x-api-key': 'YOUR_ZUPLO_KEY',
    'Content-Type': 'application/json'
  }
});

const result = await response.json();
console.log('Setup result:', result);
```

### Monitoring Setup Status

```typescript
// Check system health
const status = await fetch(`${API_URL}/api/v1/analyticsStatus`, {
  headers: {
    'x-api-key': 'YOUR_ZUPLO_KEY'
  }
});

const health = await status.json();
console.log('System health:', health.status);
```

## Development

### Testing Analytics Functions
```typescript
import { 
  getFastAnalyticsData, 
  handleNewDeclaration 
} from "@commonsdb/core/searchUtils/analyticsUtil";

// Get current analytics
const data = await getFastAnalyticsData();

// Simulate new declaration
await handleNewDeclaration("declarer-id", "ISCC:...", true);
```

### Local Testing
```bash
# Deploy with analytics
sst dev --stage staging

# Initialize the system after deployment
curl -X POST -H "x-api-key: YOUR_KEY" \
  "https://your-api.execute-api.region.amazonaws.com/api/v1/setupAnalytics"

# Test fast analytics endpoint
curl -H "x-api-key: YOUR_KEY" \
  "https://your-api.execute-api.region.amazonaws.com/api/v1/uniqueIsccCount"

# Check system status
curl -H "x-api-key: YOUR_KEY" \
  "https://your-api.execute-api.region.amazonaws.com/api/v1/analyticsStatus"
```

## Future Enhancements

1. **Real-time Unique ISCC Detection**: Implement efficient duplicate checking
2. **Historical Analytics**: Store time-series data for trends
3. **Advanced Metrics**: Add performance and usage analytics
4. **Dashboard Integration**: Connect to monitoring dashboards
5. **Alert Thresholds**: Configurable drift and performance alerts

## Troubleshooting

### High Data Drift
- Check real-time update functions
- Verify declaration processor integration
- Review error logs for failed updates

### Slow Responses
- Verify analytics table performance
- Check DynamoDB throttling
- Monitor Lambda execution times

### Missing Data
- Ensure cron job is running
- Check IAM permissions
- Verify table bindings in stack configuration
