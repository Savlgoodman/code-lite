package com.codelite.remote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ImageAlbumPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
