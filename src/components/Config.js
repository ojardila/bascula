import React, { Component } from 'react';
import { bytesToString } from 'convert-string';
import RegisterPickup from './RegisterPickup';
import realm from '../Models';


import {
  AppRegistry,
  StyleSheet,
  View,
  TouchableHighlight,
  NativeAppEventEmitter,
  NativeEventEmitter,
  NativeModules,
  Platform,
  PermissionsAndroid,
  ListView,
  ScrollView,
  Alert,
  AppState
} from 'react-native';
import PubSub from 'pubsub-js';
import {  FooterMenu } from './common';
import { Actions } from 'react-native-router-flux';


import { Container, Header, Content, List, ListItem, Text, Icon, Left, Body, Right, Switch } from 'native-base';

import Dimensions from 'Dimensions';
import BleManager from 'react-native-ble-manager';
import TimerMixin from 'react-timer-mixin';
import reactMixin from 'react-mixin';

const window = Dimensions.get('window');
const ds = new ListView.DataSource({rowHasChanged: (r1, r2) => r1 !== r2});

const BleManagerModule = NativeModules.BleManager;
const bleManagerEmitter = new NativeEventEmitter(BleManagerModule);

export default class Config extends Component {
  constructor(){
    super()

    this.state = {
      scanning:false,
      peripherals: new Map(),
      appState: ''
    }

    this.handleDiscoverPeripheral = this.handleDiscoverPeripheral.bind(this);
    this.handleStopScan = this.handleStopScan.bind(this);
    this.handleUpdateValueForCharacteristic = this.handleUpdateValueForCharacteristic.bind(this);
    this.handleDisconnectedPeripheral = this.handleDisconnectedPeripheral.bind(this);
    this.handleAppStateChange = this.handleAppStateChange.bind(this);
  }

  componentDidMount() {
    AppState.addEventListener('change', this.handleAppStateChange);
    BleManager.isPeripheralConnected('67DAB699-E196-008E-FAFD-5DC29B33B7CB', [])
    .then((isConnected) => {
    if (isConnected) {
      console.log('Peripheral is connected!');
    } else {
      BleManager.start({showAlert: false});
    }
    });
    

    this.handlerDiscover = bleManagerEmitter.addListener('BleManagerDiscoverPeripheral', this.handleDiscoverPeripheral );
    this.handlerStop = bleManagerEmitter.addListener('BleManagerStopScan', this.handleStopScan );
    this.handlerDisconnect = bleManagerEmitter.addListener('BleManagerDisconnectPeripheral', this.handleDisconnectedPeripheral );
    this.handlerUpdate = bleManagerEmitter.addListener('BleManagerDidUpdateValueForCharacteristic', this.handleUpdateValueForCharacteristic );



    if (Platform.OS === 'android' && Platform.Version >= 23) {
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION).then((result) => {
            if (result) {
              console.log("Permission is OK");
            } else {
              PermissionsAndroid.requestPermission(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION).then((result) => {
                if (result) {
                  console.log("User accept");
                } else {
                  console.log("User refuse");
                }
              });
            }
      });
    }

  }

  handleAppStateChange(nextAppState) {
    if (this.state.appState.match(/inactive|background/) && nextAppState === 'active') {
      console.log('App has come to the foreground!')
      BleManager.getConnectedPeripherals([]).then((peripheralsArray) => {
        console.log('Connected peripherals: ' + peripheralsArray.length);
      });
    }
    this.setState({appState: nextAppState});
  }

  componentWillUnmount() {
    this.handlerDiscover.remove();
    this.handlerStop.remove();
    this.handlerDisconnect.remove();
    this.handlerUpdate.remove();
  }

  handleDisconnectedPeripheral(data) {
    let peripherals = this.state.peripherals;
    let peripheral = peripherals.get(data.peripheral);
    if (peripheral) {
      peripheral.connected = false;
      peripherals.set(peripheral.id, peripheral);
      peripherals: new Map(),
      this.setState({peripherals});


    }
    Alert.alert(
      'Desconectado  de ',
      data.peripheral,
    );
  }

  handleUpdateValueForCharacteristic(data) {
    let payload = bytesToString(data.value);
    data = JSON.parse(payload);
    if(data.w) {
      PubSub.publish('weight', data.w);
    }
    if(data.c) {
      if(Actions.currentScene!="people_add"){
        let person = realm.objects('Person').filtered(`tag = "${data.c.toUpperCase()}"`);
        if (person.length > 0) {
          Actions.register_pickup({ card: data.c });
        } else {
          Alert.alert(
            'Error',
            'Tarjeta Inválida'
          );
        }
         
      } else {
        PubSub.publish('card', data.c);
      }
     
    }

    console.log(JSON.parse(payload));
  }

  handleStopScan() {
    console.log('Scan is stopped');
    this.setState({ scanning: false });
  }

  startScan() {

  }

  handleDiscoverPeripheral(peripheral){
    var peripherals = this.state.peripherals;
    if (!peripherals.has(peripheral.id)){
      console.log('Got ble peripheral', peripheral);
      peripherals.set(peripheral.id, peripheral);
      this.setState({ peripherals })
    }
  }
  searchDevices(data) {
    this.setState({trueSwitchIsOn: data.trueSwitchIsOn })
    BleManager.isPeripheralConnected('67DAB699-E196-008E-FAFD-5DC29B33B7CB', [])
    .then((isConnected) => {
    if (isConnected) {
      BleManager.disconnect('67DAB699-E196-008E-FAFD-5DC29B33B7CB');
      this.setState({scanning:false});

    } else {
      if (data.trueSwitchIsOn && !this.state.scanning) {
      BleManager.scan([], 10, true).then((results) => {
        console.log('Scanning...');
        this.setState({scanning:true});
      });
    } else {
      let peripherals = new Map()
      this.setState({peripherals});

    }
    }
    });
    

  }
  connectTo(peripheral) {
    if (peripheral){
      if (peripheral.connected){
        BleManager.disconnect(peripheral.id);
      } else{
        BleManager.connect(peripheral.id).then(() => {
          let peripherals = this.state.peripherals;
          let p = peripherals.get(peripheral.id);
          if (p) {
            p.connected = true;
            peripherals.set(peripheral.id, p);
            this.setState({peripherals});
          }
          Alert.alert(
            'Conectado a',
            peripheral.id,
          );
          BleManager.retrieveServices(peripheral.id).then((peripheralInfo) => {

            BleManager.startNotification(peripheralInfo.id, 'FFE0', 'FFE1').then(() => {
              console.log('Started notification on ' + peripheral.id);
            }).catch((error) => {
              console.log('Notification error', error);
            });

          });

        }).catch((error) => {

          Alert.alert(
            'Error',
            error,
          );
          console.log('Connection error', error);
        });
      }
    }

  }
  renderView(){
    const list = Array.from(this.state.peripherals.values());
    const dataSource = ds.cloneWithRows(list);    
    return (
      <View style={styles.container}>

        <Content>
          <List>
            <ListItem itemDivider>
              <Text>Opciones</Text>
            </ListItem>  
            <ListItem icon>
              <Left>
                <Icon name="bluetooth" />
               </Left>
              <Body>
                <Text>Buscar dipositivos</Text>
              </Body>
              <Right>
                <Switch value={false} onValueChange={(value) => this.searchDevices({trueSwitchIsOn: value})} value={this.state.trueSwitchIsOn}  />
              </Right>
            </ListItem>
          </List>

          <List>
            <ListItem itemDivider>
              <Text>Dispositivos</Text>
            </ListItem>                    
          <ListView
            enableEmptySections={true}
            dataSource={dataSource}
            renderRow={(item) => {
              const color = item.connected ? 'green' : '#fff';
              return (
                <TouchableHighlight >
                  <View style={[styles.row, {backgroundColor: color}]}>
                    <ListItem onPress={() => this.connectTo(item) }><Text>{item.name}</Text></ListItem>
                  </View>
                </TouchableHighlight>
              );
            }}
          />
          </List>

        </Content>
        <FooterMenu />

      </View>
    );
  }
  render() {
    return (
      <View style={{ flex: 1 }} >
        {this.renderView()}
      </View>
    );




  }
}
reactMixin(Config.prototype, TimerMixin);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFF',
    width: window.width,
    height: window.height
  },
  scroll: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    margin: 10,
  },
  row: {
    margin: 10
  },
});