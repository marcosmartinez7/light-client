import {Raiden} from "raiden";

import { createLocalStorage } from "localstorage-ponyfill";
const localStorage = createLocalStorage();

Raiden.create("http://192.168.1.244:4444", "0xBD056E01939BC80076E22E232191C6D31B6956645CAA4A763B1BE6D0F02C6C51", localStorage)
    .then( (raiden)=>{
        raiden.channels$.subscribe((channels) => console.log('Channels: ', channels));
        raiden.openChannel('0xff10e500973A0B0071e2263421e4AF60425834a6', '0xb5d85D3386EEb3ee9Cb72CDE223362c25b6933F0')
            .then((receipt) => console.log("Open channel Tx Receipt:", receipt))
            .catch((e)=> console.log("Error opening channel",e));
    })
    .catch((e)=>console.log("Error during sdk creation ",e));