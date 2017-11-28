import React, { Component } from 'react';
import { View, Text, StyleSheet } from 'react-native'

import { Container, Content,  Form, Item, Input, Label, Picker} from 'native-base';

class PickerElement extends Component {


  render() {

    const { PickerStyle, } = styles;

    return (
        <View>

          <Picker iosHeader="Select one" mode="dropdown">
            <Picker.Item label="Wallet" value="key0" />
            <Picker.Item label="ATM Card" value="key1" />
            <Picker.Item label="Debit Card" value="key2" />
            <Picker.Item label="Credit Card" value="key3" />
            <Picker.Item label="Net Banking" value="key4" />
          </Picker>
          </View>
    );
  }
}

const styles = {
  PickerStyle: {
    width:200,
    marginTop:0,
  }


};
export { PickerElement };
