import {Database} from '.';

const DATABASE_SESSION: Database<'session'> = {
  name: 'impulsem',
  version: 1,
  stores: [{
    name: 'session'
  }]
};

export default DATABASE_SESSION;
