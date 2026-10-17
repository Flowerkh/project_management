package egovframework.shop.settle.service.impl;

import javax.annotation.Resource;
import org.springframework.stereotype.Service;
import egovframework.rte.fdl.cmmn.EgovAbstractServiceImpl;
import egovframework.shop.settle.service.SettleService;
import egovframework.shop.settle.service.SettleVO;

@Service("settleservice")
public class SettleServiceImpl extends EgovAbstractServiceImpl implements SettleService {

    @Resource(name = "settledao")
    private SettleDAO settledao;

    @Override
    public Object selectSettleList(SettleVO vo) throws Exception {
        return settledao.selectSettleList(vo);
    }

    @Override
    public Object selectSettle(SettleVO vo) throws Exception {
        return settledao.selectSettle(vo);
    }

    @Override
    public Object selectSettleItemList(SettleVO vo) throws Exception {
        return settledao.selectSettleItemList(vo);
    }

    @Override
    public Object updateSettleStat(SettleVO vo) throws Exception {
        return settledao.updateSettleStat(vo);
    }

    @Override
    public Object selectSellerList(SettleVO vo) throws Exception {
        return settledao.selectSellerList(vo);
    }

    @Override
    public Object insertSeller(SettleVO vo) throws Exception {
        return settledao.insertSeller(vo);
    }

    @Override
    public Object selectSalesMonthly(SettleVO vo) throws Exception {
        return settledao.selectSalesMonthly(vo);
    }

}
