import { registerDeliveryAction } from '../../delivery.js';
import { handleSetThreadTitle } from './actions.js';

registerDeliveryAction('set_thread_title', handleSetThreadTitle);
