import { combineReducers } from 'redux';
import Home from './Home';
import People from './People';
import Crops from './Crops';
import PeopleAdd from './PeopleAdd';

export default combineReducers({
  home: Home,
  people: People,
  crops: Crops,
  people_add: PeopleAdd,

});