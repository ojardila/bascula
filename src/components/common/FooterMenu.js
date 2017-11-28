import React, { Component } from 'react';
import { Container, Header, Content, Footer, FooterTab, Button, Icon, Text } from 'native-base';
import { Actions } from 'react-native-router-flux';
import BleManager from 'react-native-ble-manager';

class FooterMenu extends Component {
  constructor(){
  super()

  this.state = {
    actual:"home",
    bluetooh: Object(),
  }
  }
  goToHarvest() {
    Actions.harvest();
    this.setState({actual: "home"});
  }
  goToCosecha() {
    Actions.people();
    this.setState({actual: "people"});

  }
  goToCrops() {
    Actions.crops();
    this.setState({actual: "crops"});
  }

  goToConfig() {
    Actions.config();
    this.setState({actual: "config"});

  }

    componentWillReceiveProps(nextProps){
    console.log('componentWillReceiveProps.');
  }
 componentDidMount() {
    console.log('componentDidMount');
    console.log(BleManager);
  }
    componentWillMount() {
    console.log('componentWillMount');
  }
  render() {
    return (
       <Footer>
          <FooterTab>
            <Button onPress={this.goToHarvest.bind(this)} vertical>
              <Icon active name="ios-leaf" />
              <Text>Cosecha</Text>
            </Button>
            <Button onPress={this.goToCosecha.bind(this)} vertical>
              <Icon name="ios-contacts" />
              <Text>Personas</Text>
            </Button>
            <Button onPress={this.goToCrops.bind(this)} vertical>
              <Icon name="grid" />
              <Text>Lotes</Text>
            </Button>
            <Button onPress={this.goToConfig.bind(this)} vertical>
              <Icon name="settings" />
              <Text>Config</Text>
            </Button>

          </FooterTab>
        </Footer>
    );
  }
}

export { FooterMenu };
