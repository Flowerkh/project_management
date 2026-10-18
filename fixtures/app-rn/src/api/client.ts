import axios from 'axios';
import Config from 'react-native-config';

const client = axios.create({
  baseURL: Config.API_URL,
  timeout: 10000,
});

export default client;
