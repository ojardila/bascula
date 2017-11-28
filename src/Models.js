'use strict';



import Realm from 'realm';

class Person extends Realm.Object {}

Person.schema = {
    name: 'Person',
    properties: {
      name:     'string',
      documentType: 'string',
      id: 'string',
      creationDate: 'date',
      lastName:     'string',
      image:     'string',
      tag:     'string',

  }
};
class Crop extends Realm.Object {}

Crop.schema = {
    name: 'Crop',
    properties: {
      id: 'int',
      name: 'string',
      type:'string',
      dimension:'float',
      variety:'string',
      creationDate: 'date',
  }
};

class Pickup extends Realm.Object {}

Pickup.schema = {
    name: 'Pickup',
    properties: {
      id: 'int',
      card: 'string',
      crop:'int',
      weight:'float',
      date: 'date',
      creationDate: 'date',
  }
};

export default new Realm({schema: [Person, Crop, Pickup]});
