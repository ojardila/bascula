import React from 'react';
import { Scene, Router } from 'react-native-router-flux';
import Home from './components/Home';
import People from './components/People';
import PeopleAdd from './components/PeopleAdd';
import RegisterPickup from './components/RegisterPickup';
import CropAdd from './components/CropAdd';

import Config from './components/Config';
import Crops from './components/Crops';
import { Actions } from 'react-native-router-flux';
import { View, Icon, Text } from 'native-base';

import {
  TouchableOpacity,
} from 'react-native';

let backButtonFunction = function() {

  return (
      <TouchableOpacity style={[{
        width: 100,
        height: 37,
        position: 'absolute',
        bottom: 4,
        left: 2,
        padding: 8,
        justifyContent:'center',
    }]} onPress={Actions.pop}>
        <View style={{flexDirection:'row', alignItems:'center'}}>
          <Text></Text>
        </View>
      </TouchableOpacity>
  );
};
const RouterComponent = () => {
  return (
    <Router>
      <Scene key="main" renderLeftButton={backButtonFunction} >
        <Scene key="harvest" component={Home} initial/>
        <Scene key="people" component={People}/>
        <Scene key="people_add" component={PeopleAdd}/>
        <Scene key="register_pickup" component={RegisterPickup}/>
        <Scene key="crops" component={Crops}/>
        <Scene key="crop_add" component={CropAdd}/>
        <Scene key="config" component={Config}/>

      </Scene>
    </Router>
  );
};
export default RouterComponent;
