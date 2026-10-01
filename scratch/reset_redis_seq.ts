import { redisService } from '../src/services/Common/redis.service.js';

async function reset() {
    try {
        await redisService.del('token_seq:HOSP11-2026');
        console.log('Redis token_seq key deleted successfully.');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

reset();
